// Minimal ambient typings for the Web Speech API (not in lib.dom.d.ts).
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  }
}

export type VoiceState = "unsupported" | "idle" | "listening" | "awake" | "denied" | "error";

export interface VoiceControlCallbacks {
  onState(state: VoiceState): void;
  /** Live captions — fires on every interim + final chunk for a Jarvis-style subtitle. */
  onTranscript(text: string, isFinal: boolean, confidence: number): void;
  /** A wake word was heard and Ultron is now waiting for a command. */
  onWake(): void;
  /** Woke up but no command followed in time — back to wake-word-only listening. */
  onTimeout(): void;
  /** A full command was heard after the wake word (wake phrase already stripped). */
  onCommand(text: string, confidence: number): void;
  /** Realtime mic input level, 0..1, for a waveform/level meter. */
  onLevel(level: number): void;
  onError(message: string): void;
}

export interface VoiceControlOptions {
  wakeWords?: string[];
  /** How long (ms) to keep listening for a command after the wake word. */
  wakeWindowMs?: number;
  lang?: string;
}

const DEFAULT_WAKE_WORDS = ["hey ultron", "ultron", "hey jarvis"];
const DEFAULT_WAKE_WINDOW_MS = 7000;
const RESTART_DEBOUNCE_MS = 250;
const MAX_RESTART_DELAY_MS = 10_000;
// Chrome/Edge's SpeechRecognition calls out to a cloud recognition service —
// it isn't local. A persistent "network" error (no route to that service)
// would otherwise retry instantly forever, spamming the same error. Back
// off exponentially and give up with one clear message instead.
const MAX_CONSECUTIVE_ERRORS = 5;

function getSpeechRecognitionCtor(): (new () => SpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?¿¡]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strips a leading wake phrase from `text`, returning the remainder (or null if absent). */
function stripWakeWord(text: string, wakeWords: string[]): string | null {
  for (const w of wakeWords) {
    if (text === w) return "";
    if (text.startsWith(w + " ")) return text.slice(w.length).trim();
    if (text.includes(w)) return text.slice(text.indexOf(w) + w.length).trim();
  }
  return null;
}

export function isVoiceControlSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export class VoiceControl {
  private callbacks: VoiceControlCallbacks;
  private wakeWords: string[];
  private wakeWindowMs: number;
  private lang: string;

  private recognition: SpeechRecognition | null = null;
  private state: VoiceState = "idle";
  private running = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  private levelStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private levelRaf = 0;

  private consecutiveErrors = 0;

  constructor(callbacks: VoiceControlCallbacks, options: VoiceControlOptions = {}) {
    this.callbacks = callbacks;
    this.wakeWords = (options.wakeWords ?? DEFAULT_WAKE_WORDS).map(normalize);
    this.wakeWindowMs = options.wakeWindowMs ?? DEFAULT_WAKE_WINDOW_MS;
    this.lang = options.lang ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");
  }

  async start(): Promise<void> {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      this.setState("unsupported");
      return;
    }

    this.running = true;
    this.consecutiveErrors = 0;
    this.setState("listening");
    this.initRecognition(Ctor);
    this.recognition?.start();
    void this.startLevelMeter();
  }

  stop(): void {
    this.running = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.restartTimer = null;
    this.wakeTimer = null;

    if (this.recognition) {
      this.recognition.onend = null;
      this.recognition.onerror = null;
      this.recognition.onresult = null;
      this.recognition.abort();
      this.recognition = null;
    }

    this.stopLevelMeter();
    this.setState("idle");
  }

  get isRunning(): boolean {
    return this.running;
  }

  private initRecognition(Ctor: new () => SpeechRecognition): void {
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    recognition.lang = this.lang;

    recognition.onresult = (event) => {
      this.consecutiveErrors = 0; // a result proves this attempt actually reached the recognition service
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const best = this.bestAlternative(result);
        const text = normalize(best.transcript);
        if (!text) continue;

        this.callbacks.onTranscript(best.transcript.trim(), result.isFinal, best.confidence);
        if (result.isFinal) this.handleFinal(text, best.confidence);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.running = false;
        this.setState("denied");
        this.callbacks.onError("MIC ACCESS DENIED");
        return;
      }
      if (event.error === "no-speech" || event.error === "aborted") return;

      this.consecutiveErrors++;
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        this.running = false;
        this.setState("error");
        this.callbacks.onError(
          `VOICE ERROR: ${event.error.toUpperCase()} — giving up after ${this.consecutiveErrors} failed attempts. ` +
            "Check your internet connection (speech recognition calls out to a cloud service, it isn't local), " +
            "then toggle voice off/on to retry.",
        );
        return;
      }
      // Only the first failure is reported — a persistent problem would
      // otherwise print the same line on every retry.
      if (this.consecutiveErrors === 1) {
        this.callbacks.onError(`VOICE ERROR: ${event.error.toUpperCase()}`);
      }
    };

    recognition.onend = () => {
      if (!this.running) return;
      // Mobile/desktop browsers stop recognition after brief silence — restart
      // it automatically so listening behaves like an always-on wake word.
      // Back off on repeated failures instead of retrying instantly forever.
      const delay =
        this.consecutiveErrors > 0
          ? Math.min(RESTART_DEBOUNCE_MS * 2 ** this.consecutiveErrors, MAX_RESTART_DELAY_MS)
          : RESTART_DEBOUNCE_MS;
      this.restartTimer = setTimeout(() => {
        if (!this.running) return;
        try {
          this.recognition?.start();
        } catch {
          // already started — ignore
        }
      }, delay);
    };

    this.recognition = recognition;
  }

  private bestAlternative(result: SpeechRecognitionResult): SpeechRecognitionAlternative {
    let best = result[0];
    for (let i = 1; i < result.length; i++) {
      if (result[i].confidence > best.confidence) best = result[i];
    }
    return best;
  }

  private handleFinal(text: string, confidence: number): void {
    if (this.state === "awake") {
      const remainder = stripWakeWord(text, this.wakeWords);
      const command = remainder !== null ? remainder : text;
      this.clearWakeTimer();
      if (command) {
        this.callbacks.onCommand(command, confidence);
      }
      this.setState("listening");
      return;
    }

    const remainder = stripWakeWord(text, this.wakeWords);
    if (remainder === null) return;

    this.callbacks.onWake();
    if (remainder) {
      // "Hey Ultron open Spotify" said in one breath — act immediately.
      this.callbacks.onCommand(remainder, confidence);
      this.setState("listening");
    } else {
      this.setState("awake");
      this.armWakeTimer();
    }
  }

  private armWakeTimer(): void {
    this.clearWakeTimer();
    this.wakeTimer = setTimeout(() => {
      if (this.state === "awake") {
        this.setState("listening");
        this.callbacks.onTimeout();
      }
    }, this.wakeWindowMs);
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  private setState(state: VoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onState(state);
  }

  private async startLevelMeter(): Promise<void> {
    try {
      this.levelStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioCtx();
      const source = this.audioCtx.createMediaStreamSource(this.levelStream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!this.running) return;
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        this.callbacks.onLevel(Math.min(1, rms * 4));
        this.levelRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // Level metering is cosmetic — recognition still works without it.
    }
  }

  private stopLevelMeter(): void {
    cancelAnimationFrame(this.levelRaf);
    this.levelStream?.getTracks().forEach((t) => t.stop());
    this.levelStream = null;
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.callbacks.onLevel(0);
  }
}
