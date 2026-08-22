"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import { VoiceControl, isVoiceControlSupported, type VoiceState } from "@/lib/voiceControl";
import { parseCommand } from "@/lib/commandParser";
import { resolveWebApp, openWebApp } from "@/lib/webFallback";
import { NativeAgentClient, type AgentState, type AgentInfo } from "@/lib/nativeAgent";
import {
  readStaticDeviceInfo,
  watchBattery,
  readAudioDeviceLabels,
  type StaticDeviceInfo,
  type BatteryReading,
  type AudioDeviceLabels,
} from "@/lib/systemInfo";
import { fetchWeather, type WeatherReading } from "@/lib/weather";

type CameraState = "off" | "starting" | "on" | "error";
type WeatherPhase = "idle" | "loading" | "unavailable" | "ready";

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

const QUICK_ACTIONS = [
  { label: "OPEN BROWSER", target: "browser" },
  { label: "SCREENSHOT", target: "screenshot" },
  { label: "LOCK SCREEN", target: "lock" },
  { label: "TERMINAL", target: "terminal" },
];

const METER_BARS = 14;

const BOOT_SEQUENCE = [
  "ULTRON CORE :: INITIALIZING",
  "RENDER PIPELINE ... OK",
  "VISION SUBSYSTEM ... STANDBY",
  "AUDIO SUBSYSTEM ... STANDBY",
  "NEURAL LINK ESTABLISHED",
];
const BOOT_LINE_DELAY_MS = 260;
const BOOT_HOLD_MS = 500;

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** A single SVG bracket, mirrored per corner via CSS transforms to frame the viewport. */
function CornerBracket({ corner }: { corner: "tl" | "tr" | "bl" | "br" }) {
  return (
    <svg className={`corner-bracket ${corner}`} viewBox="0 0 24 24" aria-hidden>
      <path d="M2 18 V2 H18" />
    </svg>
  );
}

/** A short staged boot readout on first mount, purely cosmetic. */
function BootSequence({ hidden }: { hidden: boolean }) {
  const [lineCount, setLineCount] = useState(0);

  useEffect(() => {
    const timers = BOOT_SEQUENCE.map((_, i) => setTimeout(() => setLineCount(i + 1), i * BOOT_LINE_DELAY_MS));
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className={`boot-overlay${hidden ? " hidden" : ""}`} aria-hidden>
      <div className="boot-lines">
        {BOOT_SEQUENCE.slice(0, lineCount).map((line, i) => (
          <div key={i} className="boot-line">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A circular readout ring. `percent` null renders an empty "N/A" ring rather than faking a value. */
function Gauge({ label, percent, valueText, tone }: { label: string; percent: number | null; valueText: string; tone: string }) {
  const radius = 25;
  const circumference = 2 * Math.PI * radius;
  const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const offset = circumference - (clamped / 100) * circumference;
  return (
    <div className="gauge">
      <svg viewBox="0 0 64 64" aria-hidden>
        <circle className="gauge-track" cx="32" cy="32" r={radius} />
        <circle
          className={`gauge-fill ${tone}`}
          cx="32"
          cy="32"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={percent === null ? circumference : offset}
        />
      </svg>
      <div className="gauge-value">{valueText}</div>
      <div className="gauge-label">{label}</div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-row">
      <span>{label}</span>
      <span className="stat-value">{value}</span>
    </div>
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
  const [executing, setExecuting] = useState(false);

  const [agentState, setAgentState] = useState<AgentState>("disconnected");
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);

  const [clock, setClock] = useState("");
  const [date, setDate] = useState("");
  const [uptime, setUptime] = useState("00:00:00");
  const [sessionId, setSessionId] = useState("------");
  const [bootHidden, setBootHidden] = useState(false);

  const [deviceInfo, setDeviceInfo] = useState<StaticDeviceInfo>({
    cpuCores: null,
    deviceMemoryGB: null,
    downlinkMbps: null,
    effectiveType: null,
  });
  const [battery, setBattery] = useState<BatteryReading | null>(null);
  const [audioLabels, setAudioLabels] = useState<AudioDeviceLabels>({ mic: null, speaker: null });
  const [micLevel, setMicLevel] = useState(0);
  const [fps, setFps] = useState(0);

  const [weatherPhase, setWeatherPhase] = useState<WeatherPhase>("idle");
  const [weather, setWeather] = useState<WeatherReading | null>(null);

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

  // ——— real render performance (measures this page's actual frame rate) ———
  useEffect(() => {
    let rafId = 0;
    let frames = 0;
    let windowStart = 0;
    const loop = (t: number) => {
      if (windowStart === 0) windowStart = t;
      frames++;
      if (t - windowStart >= 500) {
        setFps(Math.round((frames * 1000) / (t - windowStart)));
        frames = 0;
        windowStart = t;
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // ——— device info: CPU/memory/network are static; battery is a live subscription ———
  useEffect(() => {
    setDeviceInfo(readStaticDeviceInfo());
    return watchBattery(setBattery);
  }, []);

  useEffect(() => {
    readAudioDeviceLabels().then(setAudioLabels);
  }, []);

  // Device labels are blank until permission is granted — re-read once voice actually starts.
  useEffect(() => {
    if (voiceState !== "idle" && voiceState !== "unsupported") {
      readAudioDeviceLabels().then(setAudioLabels);
    }
  }, [voiceState]);

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
    const client = new NativeAgentClient({
      onState: (state) => {
        setAgentState(state);
        if (state !== "connected") setAgentInfo(null);
      },
      onInfo: setAgentInfo,
    });
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

  // ——— opening an app/action: shared by voice commands and the quick-action buttons ———
  const openTarget = useCallback(async (target: string) => {
    setExecuting(true);
    try {
      const agent = agentRef.current;
      if (agent?.connected) {
        const result = await agent.openApp(target);
        if (result.ok) return;
      }
      const url = resolveWebApp(target);
      if (url) openWebApp(url);
    } finally {
      setExecuting(false);
    }
  }, []);

  // ——— voice command dispatch ———
  const runCommand = useCallback(
    async (heard: string) => {
      const command = parseCommand(heard);

      if (command.type === "open") {
        await openTarget(command.target);
        return;
      }

      if (command.type === "orb") {
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
    },
    [openTarget, startGestures, stopGestures],
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
      onTranscript: () => {},
      onWake: () => {},
      onTimeout: () => {},
      onCommand: (text) => void runCommand(text),
      onLevel: paintMeter,
      onError: (message) => console.error(message),
    });
    voiceRef.current = voice;
    void voice.start();
  }, [paintMeter, runCommand]);

  const stopVoice = useCallback(() => {
    voiceRef.current?.stop();
    voiceRef.current = null;
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

  // ——— weather: only fetched on request, since it needs a geolocation permission prompt ———
  const enableWeather = useCallback(() => {
    if (weatherPhase === "loading" || weatherPhase === "ready") return;
    setWeatherPhase("loading");
    fetchWeather().then((reading) => {
      if (reading) {
        setWeather(reading);
        setWeatherPhase("ready");
      } else {
        setWeatherPhase("unavailable");
      }
    });
  }, [weatherPhase]);

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

  // ——— clock, date, uptime, session id, mic-level sample, boot timing ———
  useEffect(() => {
    const startedAt = Date.now();
    const tick = () => {
      const now = new Date();
      setClock(now.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setDate(now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }));
      setUptime(formatDuration(Math.floor((Date.now() - startedAt) / 1000)));
      setMicLevel(Math.round((meterHistoryRef.current[METER_BARS - 1] ?? 0) * 100));
    };
    tick();
    const id = setInterval(tick, 700);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setSessionId(Math.random().toString(16).slice(2, 8).toUpperCase());
    const id = setTimeout(() => setBootHidden(true), BOOT_SEQUENCE.length * BOOT_LINE_DELAY_MS + BOOT_HOLD_MS);
    return () => clearTimeout(id);
  }, []);

  const cameraOn = cameraState === "on";
  const voiceOn = voiceState === "listening" || voiceState === "awake";
  const voiceDotClass = voiceState === "awake" ? "awake" : voiceState === "listening" ? "live" : "";
  const micGranted = voiceState !== "idle" && voiceState !== "unsupported" && voiceState !== "denied";
  const secure = typeof window !== "undefined" && window.location.protocol === "https:";

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
      <BootSequence hidden={bootHidden} />

      {/* ——— top bar ——— */}
      <div className="hud topbar">
        <div className="topbar-brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <div className="brand-title">U.L.T.R.O.N.</div>
            <div className="brand-subtitle">Voice-controlled interface</div>
          </div>
        </div>
        <div className="topbar-hint">Say &quot;Hey Ultron&quot; or press V</div>
        <div className="topbar-clock">
          <div className="clock">{clock || "--:--:--"}</div>
          <div className="date">{date}</div>
        </div>
      </div>

      {/* ——— left sidebar ——— */}
      <div className="hud sidebar sidebar-left">
        <div className="card">
          <div className="card-header">
            <span className="card-title">SYSTEM STATUS</span>
            <span className="card-badge live">● LIVE</span>
          </div>
          <div className="gauge-row">
            <Gauge label="MIC" percent={voiceOn ? micLevel : 0} valueText={voiceOn ? `${micLevel}%` : "OFF"} tone="c-mic" />
            <Gauge label="FPS" percent={Math.min(100, (fps / 60) * 100)} valueText={String(fps)} tone="c-fps" />
            <Gauge
              label="BATTERY"
              percent={battery ? battery.level * 100 : null}
              valueText={battery ? `${Math.round(battery.level * 100)}%` : "N/A"}
              tone="c-battery"
            />
          </div>
          <StatRow
            label="NETWORK"
            value={
              deviceInfo.downlinkMbps
                ? `${deviceInfo.downlinkMbps} Mbps`
                : (deviceInfo.effectiveType?.toUpperCase() ?? "N/A")
            }
          />
          <StatRow label="CPU CORES" value={deviceInfo.cpuCores ? String(deviceInfo.cpuCores) : "N/A"} />
          <StatRow label="MEMORY" value={deviceInfo.deviceMemoryGB ? `${deviceInfo.deviceMemoryGB} GB` : "N/A"} />
          <StatRow label="MICROPHONE" value={audioLabels.mic ?? "permission needed"} />
          <StatRow label="SPEAKER" value={audioLabels.speaker ?? "permission needed"} />
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">AGENT</span>
          </div>
          <button type="button" className="agent-pill" data-state={agentState} onClick={connectAgent}>
            {AGENT_LABEL[agentState]}
          </button>
          {agentInfo && (
            <>
              <StatRow label="PLATFORM" value={agentInfo.platform} />
              <StatRow label="ALLOWLIST" value={`${agentInfo.appCount} apps`} />
            </>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">QUICK ACTIONS</span>
            <span className={`card-badge${agentState === "connected" ? " live" : ""}`}>
              {agentState === "connected" ? "READY" : "NEEDS AGENT"}
            </span>
          </div>
          <div className="quick-grid">
            {QUICK_ACTIONS.map((qa) => (
              <button
                key={qa.target}
                type="button"
                className="quick-btn"
                onClick={() => void openTarget(qa.target)}
                disabled={agentState !== "connected"}
                title={agentState !== "connected" ? "Connect the local agent (see the AGENT card) to use this" : undefined}
              >
                {qa.label}
              </button>
            ))}
          </div>
        </div>

        {cameraOn && (
          <div className="card">
            <div className="card-header">
              <span className="card-title">GESTURE CAM</span>
            </div>
            <div className="camera-preview visible">
              <video ref={videoRef} muted playsInline className="camera-video" />
              <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
              <div className="camera-status">
                {gestureStatus.hands > 0
                  ? `${gestureStatus.hands} HAND${gestureStatus.hands > 1 ? "S" : ""} · ${GESTURE_LABEL[gestureStatus.mode]}`
                  : "SHOW HANDS"}
              </div>
            </div>
          </div>
        )}
      </div>
      {/* video/canvas must exist even with the cam card hidden, so gestures can still start */}
      {!cameraOn && (
        <div style={{ position: "fixed", width: 0, height: 0, overflow: "hidden" }}>
          <video ref={videoRef} muted playsInline />
          <canvas ref={overlayRef} width={208} height={156} />
        </div>
      )}

      {/* ——— right sidebar ——— */}
      <div className="hud sidebar sidebar-right">
        <div className="card">
          <div className="card-header">
            <span className="card-title">WEATHER</span>
          </div>
          {weatherPhase === "ready" && weather ? (
            <>
              <div className="weather-temp">{Math.round(weather.tempC)}°C</div>
              <div className="weather-place">{weather.place}</div>
              <div className="weather-condition">{weather.condition}</div>
            </>
          ) : weatherPhase === "loading" ? (
            <div className="stat-row">
              <span>Locating…</span>
            </div>
          ) : weatherPhase === "unavailable" ? (
            <div className="stat-row">
              <span>Location unavailable</span>
            </div>
          ) : (
            <button type="button" className="quick-btn" onClick={enableWeather}>
              ENABLE LOCATION
            </button>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">CONNECTION</span>
          </div>
          <StatRow label="PAGE" value={secure ? "ENCRYPTED (HTTPS)" : "LOCAL"} />
          <StatRow label="AGENT LINK" value={agentState === "connected" ? "AUTHENTICATED" : "NOT CONNECTED"} />
          <StatRow label="MIC ACCESS" value={micGranted ? "GRANTED" : voiceState === "denied" ? "DENIED" : "NOT REQUESTED"} />
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">ACTIVE SUBSYSTEMS</span>
          </div>
          <div className="subsystem-row">
            <span className={`subsystem-dot${voiceOn ? " up" : ""}`} />
            <span>Voice listening</span>
          </div>
          <div className="subsystem-row">
            <span className={`subsystem-dot${cameraOn ? " up" : ""}`} />
            <span>Hand tracking</span>
          </div>
          <div className="subsystem-row">
            <span className={`subsystem-dot${agentState === "connected" ? " up" : ""}`} />
            <span>Native agent</span>
          </div>
          <div className="subsystem-row">
            <span className="subsystem-dot up" />
            <span>Render loop</span>
          </div>
        </div>
      </div>

      {/* ——— center: session readout + voice status ——— */}
      <div className="hud center-status">
        <div className="session-line">
          SESSION {sessionId} · UPTIME {uptime}
        </div>
      </div>

      <div className="hud voice-strip">
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
        {executing && <div className="voice-executing">EXECUTING…</div>}
        <div className="key-hint">
          <span className="key">G</span> gestures&nbsp;&nbsp;
          <span className="key">V</span> voice&nbsp;&nbsp;
          <span className="key">R</span> reset&nbsp;&nbsp;
          <span className="key">+/−</span> zoom
        </div>
      </div>

      {/* ——— bottom bar ——— */}
      <div className="hud bottombar">
        {gestureError && <div className="hud-error">{gestureError}</div>}
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
        <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
          −
        </button>
        <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
          RESET
        </button>
      </div>
    </>
  );
}
