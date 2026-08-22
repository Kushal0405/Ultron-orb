"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import { VoiceControl, isVoiceControlSupported, type VoiceState } from "@/lib/voiceControl";
import { parseCommand } from "@/lib/commandParser";
import { resolveWebApp, openWebApp } from "@/lib/webFallback";
import { NativeAgentClient, type AgentState } from "@/lib/nativeAgent";

type CameraState = "off" | "starting" | "on" | "error";

interface LogEntry {
  id: number;
  text: string;
  kind: "heard" | "action" | "error";
}

const GESTURE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

const VOICE_LABEL: Record<VoiceState, string> = {
  unsupported: "VOICE UNSUPPORTED",
  idle: "VOICE OFF",
  listening: 'LISTENING FOR "HEY ULTRON"',
  awake: "AWAKE — GO AHEAD",
  denied: "MIC ACCESS DENIED",
  error: "VOICE ERROR",
};

const AGENT_LABEL: Record<AgentState, string> = {
  disconnected: "AGENT OFFLINE",
  connecting: "AGENT CONNECTING…",
  connected: "AGENT ONLINE",
  denied: "AGENT TOKEN REJECTED",
  error: "AGENT ERROR",
};

const METER_BARS = 14;
const LOG_LIMIT = 8;
let nextLogId = 0;

/** A single SVG bracket, mirrored per corner via CSS transforms to frame the viewport. */
function CornerBracket({ corner }: { corner: "tl" | "tr" | "bl" | "br" }) {
  return (
    <svg className={`corner-bracket ${corner}`} viewBox="0 0 24 24" aria-hidden>
      <path d="M2 18 V2 H18" />
    </svg>
  );
}

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const voiceRef = useRef<VoiceControl | null>(null);
  const agentRef = useRef<NativeAgentClient | null>(null);
  const meterBarsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const meterHistoryRef = useRef<number[]>(new Array(METER_BARS).fill(0));

  const [cameraState, setCameraState] = useState<CameraState>("off");
  const [gestureStatus, setGestureStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [gestureError, setGestureError] = useState<string | null>(null);

  const [voiceSupported, setVoiceSupported] = useState(true);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [caption, setCaption] = useState({ text: "", isFinal: true });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [agentState, setAgentState] = useState<AgentState>("disconnected");
  const [clock, setClock] = useState("");
  const [readouts, setReadouts] = useState({ core: 72, output: 88 });

  const pushLog = useCallback((text: string, kind: LogEntry["kind"] = "heard") => {
    setLog((prev) => [{ id: nextLogId++, text, kind }, ...prev].slice(0, LOG_LIMIT));
  }, []);

  // ——— orb scene lifecycle ———
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // ——— hand gestures ———
  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCameraState("off");
    setGestureStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCameraState("starting");
    setGestureError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dTheta, dPhi) => sceneRef.current?.rotateBy(dTheta, dPhi),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setGestureStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCameraState("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCameraState("error");
      setGestureError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  // ——— native agent (optional local companion — see /agent) ———
  useEffect(() => {
    const client = new NativeAgentClient({ onState: setAgentState });
    agentRef.current = client;
    if (NativeAgentClient.getToken()) client.connect();
    return () => client.disconnect();
  }, []);

  const connectAgent = useCallback(() => {
    const client = agentRef.current;
    if (!client) return;
    if (agentState === "connected" || agentState === "connecting") {
      client.disconnect();
      return;
    }
    const token = window.prompt(
      "Paste the token printed by `npm run agent`\n(see agent/README.md — leave blank to reuse the saved token)",
      NativeAgentClient.getToken(),
    );
    if (token === null) return;
    if (token.trim()) NativeAgentClient.setToken(token);
    if (NativeAgentClient.getToken()) client.connect();
  }, [agentState]);

  // ——— voice command dispatch ———
  const runCommand = useCallback(
    async (heard: string) => {
      const command = parseCommand(heard);

      if (command.type === "open") {
        pushLog(`OPEN "${command.target}"`, "heard");
        const agent = agentRef.current;
        if (agent?.connected) {
          const result = await agent.openApp(command.target);
          if (result.ok) {
            pushLog(`✓ opened ${command.target}`, "action");
            return;
          }
        }
        const url = resolveWebApp(command.target);
        if (url) {
          openWebApp(url);
          pushLog(`✓ opened ${command.target} (web)`, "action");
        } else {
          pushLog(`✗ don't know "${command.target}"`, "error");
        }
        return;
      }

      if (command.type === "orb") {
        pushLog(`> ${command.action}`, "action");
        const scene = sceneRef.current;
        switch (command.action) {
          case "spin-left":
            scene?.rotateBy(-0.8, 0);
            break;
          case "spin-right":
            scene?.rotateBy(0.8, 0);
            break;
          case "zoom-in":
            scene?.zoomIn();
            break;
          case "zoom-out":
            scene?.zoomOut();
            break;
          case "reset":
            scene?.resetView();
            break;
          case "gestures-on":
            if (!trackerRef.current) void startGestures();
            break;
          case "gestures-off":
            if (trackerRef.current) stopGestures();
            break;
        }
        return;
      }

      if (command.type === "cancel") {
        pushLog("cancelled", "heard");
        return;
      }

      pushLog(`? "${command.raw}"`, "error");
    },
    [pushLog, startGestures, stopGestures],
  );

  const paintMeter = useCallback((level: number) => {
    const history = meterHistoryRef.current;
    history.shift();
    history.push(level);
    history.forEach((v, i) => {
      const bar = meterBarsRef.current[i];
      if (bar) bar.style.height = `${2 + v * 12}px`;
    });
  }, []);

  const startVoice = useCallback(() => {
    if (voiceRef.current?.isRunning) return;
    const voice = new VoiceControl({
      onState: setVoiceState,
      onTranscript: (text, isFinal) => setCaption({ text, isFinal }),
      onWake: () => {},
      onTimeout: () => {},
      onCommand: (text) => void runCommand(text),
      onLevel: paintMeter,
      onError: (message) => pushLog(message, "error"),
    });
    voiceRef.current = voice;
    void voice.start();
  }, [paintMeter, pushLog, runCommand]);

  const stopVoice = useCallback(() => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    setCaption({ text: "", isFinal: true });
    paintMeter(0);
  }, [paintMeter]);

  const toggleVoice = useCallback(() => {
    if (voiceRef.current?.isRunning) stopVoice();
    else startVoice();
  }, [startVoice, stopVoice]);

  useEffect(() => {
    setVoiceSupported(isVoiceControlSupported());
    return () => voiceRef.current?.stop();
  }, []);

  // ——— keyboard shortcuts ———
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "v":
        case "V":
          toggleVoice();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleGestures, toggleVoice]);

  // ——— clock + ambient status readouts ———
  useEffect(() => {
    const tick = () => {
      setClock(new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      const t = Date.now() / 1000;
      setReadouts({
        core: 60 + Math.sin(t * 0.7) * 15 + Math.random() * 4,
        output: 75 + Math.cos(t * 0.5) * 10 + Math.random() * 3,
      });
    };
    tick();
    const id = setInterval(tick, 700);
    return () => clearInterval(id);
  }, []);

  const cameraOn = cameraState === "on";
  const voiceOn = voiceState === "listening" || voiceState === "awake";
  const voiceDotClass = voiceState === "awake" ? "awake" : voiceState === "listening" ? "live" : "";

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />
      <CornerBracket corner="tl" />
      <CornerBracket corner="tr" />
      <CornerBracket corner="bl" />
      <CornerBracket corner="br" />

      <div className="hud panel-title">U.L.T.R.O.N.</div>

      <div className="hud panel-status">
        <div className="clock">{clock || "--:--:--"}</div>
        <div className="readout-row">
          CORE SYNC
          <span className="readout-bar">
            <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, readouts.core / 100))})` }} />
          </span>
        </div>
        <div className="readout-row">
          REACTOR OUT
          <span className="readout-bar">
            <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, readouts.output / 100))})` }} />
          </span>
        </div>
        <button type="button" className="agent-pill" data-state={agentState} onClick={connectAgent}>
          {AGENT_LABEL[agentState]}
        </button>
      </div>

      <div className="hud panel-voice">
        <div className="voice-state">
          <span className={`voice-dot ${voiceDotClass}`} />
          {voiceSupported ? VOICE_LABEL[voiceState] : "VOICE UNSUPPORTED — TRY CHROME"}
        </div>
        <div className="voice-meter">
          {Array.from({ length: METER_BARS }).map((_, i) => (
            <span
              key={i}
              ref={(el) => {
                meterBarsRef.current[i] = el;
              }}
              style={{ height: "2px" }}
            />
          ))}
        </div>
        <div className={`voice-caption${caption.isFinal ? "" : " interim"}`}>
          {caption.text || (voiceOn ? "· say “hey ultron” ·" : "")}
        </div>
      </div>

      <div className="hud panel-log">
        {log.map((entry) => (
          <div key={entry.id} className={`log-line ${entry.kind}`}>
            {entry.text}
          </div>
        ))}
      </div>

      <div className="hud panel-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom
          </div>
        ) : (
          <div>
            <span className="key">G</span> hand gestures&nbsp;&nbsp;
            <span className="key">V</span> voice&nbsp;&nbsp;
            <span className="key">R</span> reset&nbsp;&nbsp;
            <span className="key">+/−</span> zoom
          </div>
        )}
        <div>
          <span className="key">SAY</span> &quot;hey ultron, open spotify&quot; · &quot;zoom in&quot; · &quot;reset view&quot;
        </div>
      </div>

      <div className="hud panel-controls">
        <div className={`camera-preview${cameraOn ? " visible" : ""}`}>
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {gestureStatus.hands > 0
              ? `${gestureStatus.hands} HAND${gestureStatus.hands > 1 ? "S" : ""} · ${GESTURE_LABEL[gestureStatus.mode]}`
              : "SHOW HANDS"}
          </div>
        </div>

        {gestureError && <div className="hud-error">{gestureError}</div>}

        <div className="control-row">
          <button type="button" className="hud-btn" aria-pressed={voiceOn} onClick={toggleVoice} disabled={!voiceSupported}>
            {voiceOn ? "VOICE ON" : "VOICE OFF"}
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={cameraState === "starting"}
          >
            {cameraState === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>
        <div className="control-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET
          </button>
        </div>
      </div>
    </>
  );
}
