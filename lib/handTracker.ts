import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// MediaPipe hand landmark indices used here
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const PINKY_MCP = 17;

// A pinch is scored 0..1 (closed) rather than a hard boolean, using two
// thresholds so the mode doesn't chatter right at the boundary.
const PINCH_ENGAGE = 0.34;
const PINCH_RELEASE = 0.48;
// A mode change only commits once it's held for this many consecutive
// frames — filters out single-frame landmark jitter.
const CONFIRM_FRAMES = 2;

// Spring constant for smoothing the tracked pinch point (critically-damped,
// higher = snappier). Applied per-frame scaled by dt, so tracking quality
// doesn't drift with framerate.
const SPRING_RATE = 22;
const ROTATE_GAIN = 3.6;

export type GestureMode = "idle" | "spin" | "zoom";

export interface TrackerStatus {
  hands: number;
  mode: GestureMode;
}

export interface HandTrackerCallbacks {
  /** One pinched hand moved: mirrored, dt-normalized deltas. */
  onRotate(deltaTheta: number, deltaPhi: number): void;
  /** Two pinched hands changed separation: multiply camera distance by factor. */
  onZoom(factor: number): void;
  onStatus(status: TrackerStatus): void;
}

interface Point {
  x: number;
  y: number;
}

interface HandState {
  point: Point; // spring-smoothed pinch midpoint, mirrored to screen space
  pinchStrength: number; // 0 (open) .. 1 (fully pinched)
  engaged: boolean;
}

function distance(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export class HandTracker {
  private video: HTMLVideoElement;
  private overlay: HTMLCanvasElement;
  private callbacks: HandTrackerCallbacks;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private rafId = 0;
  private running = false;
  private lastVideoTime = -1;

  private hands = new Map<string, HandState>();
  private mode: GestureMode = "idle";
  private pendingMode: GestureMode | null = null;
  private pendingFrames = 0;

  private spinAnchor: Point | null = null;
  private zoomAnchor: number | null = null;
  private lastFrameTime = 0;
  private lastReportedStatus: TrackerStatus = { hands: 0, mode: "idle" };

  constructor(video: HTMLVideoElement, overlay: HTMLCanvasElement, callbacks: HandTrackerCallbacks) {
    this.video = video;
    this.overlay = overlay;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
    const baseOptions = { modelAssetPath: MODEL_URL, delegate: "GPU" as const };
    const options = {
      baseOptions,
      runningMode: "VIDEO" as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    };
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options);
    } catch {
      // Some GPUs/browsers reject the GPU delegate — retry on CPU.
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...baseOptions, delegate: "CPU" as const },
      });
    }

    this.running = true;
    this.lastFrameTime = performance.now();
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.hands.clear();
    this.mode = "idle";
    this.pendingMode = null;
    this.pendingFrames = 0;
    this.spinAnchor = null;
    this.zoomAnchor = null;
    this.overlay.getContext("2d")?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.report({ hands: 0, mode: "idle" });
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const now = performance.now();
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    const result = this.landmarker.detectForVideo(this.video, now);
    this.processFrame(result.landmarks, result.handedness.map((h) => h[0]?.categoryName ?? "?"), dt);
    this.paintOverlay(result.landmarks);
  };

  private processFrame(landmarksList: NormalizedLandmark[][], labels: string[], dt: number): void {
    const seen = new Set<string>();
    const pinchedPoints: Point[] = [];

    landmarksList.forEach((lm, i) => {
      const label = labels[i];
      seen.add(label);

      const palmWidth = distance(lm[INDEX_MCP], lm[PINKY_MCP]);
      if (palmWidth < 1e-6) return;

      const openness = distance(lm[THUMB_TIP], lm[INDEX_TIP]) / palmWidth;
      const targetStrength = clamp01(1 - openness / 1.1);

      const mirrored: Point = {
        x: 1 - (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2,
        y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2,
      };

      let state = this.hands.get(label);
      if (!state) {
        state = { point: mirrored, pinchStrength: targetStrength, engaged: false };
        this.hands.set(label, state);
      }

      // Critically-damped spring toward the raw target, scaled by dt so
      // tracking feel is independent of the actual frame rate.
      const pull = 1 - Math.exp(-SPRING_RATE * dt);
      state.point.x += (mirrored.x - state.point.x) * pull;
      state.point.y += (mirrored.y - state.point.y) * pull;
      state.pinchStrength += (targetStrength - state.pinchStrength) * pull;

      const engageAt = 1 - PINCH_ENGAGE;
      const releaseAt = 1 - PINCH_RELEASE;
      if (state.engaged && state.pinchStrength < releaseAt) state.engaged = false;
      else if (!state.engaged && state.pinchStrength > engageAt) state.engaged = true;

      if (state.engaged) pinchedPoints.push(state.point);
    });

    for (const label of Array.from(this.hands.keys())) {
      if (!seen.has(label)) this.hands.delete(label);
    }

    const rawMode: GestureMode = pinchedPoints.length >= 2 ? "zoom" : pinchedPoints.length === 1 ? "spin" : "idle";
    const mode = this.debounceMode(rawMode);

    if (mode !== this.mode) {
      this.spinAnchor = null;
      this.zoomAnchor = null;
      this.mode = mode;
    }

    if (mode === "spin" && pinchedPoints[0]) {
      const p = pinchedPoints[0];
      if (this.spinAnchor) {
        const dx = p.x - this.spinAnchor.x;
        const dy = p.y - this.spinAnchor.y;
        if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
          this.callbacks.onRotate(dx * ROTATE_GAIN, dy * ROTATE_GAIN);
        }
      }
      this.spinAnchor = p;
    } else if (mode === "zoom" && pinchedPoints[0] && pinchedPoints[1]) {
      const d = Math.hypot(pinchedPoints[0].x - pinchedPoints[1].x, pinchedPoints[0].y - pinchedPoints[1].y);
      if (this.zoomAnchor && d > 1e-4) {
        const factor = Math.min(1.16, Math.max(0.86, this.zoomAnchor / d));
        this.callbacks.onZoom(factor);
      }
      this.zoomAnchor = d;
    }

    this.report({ hands: landmarksList.length, mode });
  }

  /** Requires a mode to hold for CONFIRM_FRAMES straight frames before it takes effect. */
  private debounceMode(candidate: GestureMode): GestureMode {
    if (candidate === this.mode) {
      this.pendingMode = null;
      this.pendingFrames = 0;
      return this.mode;
    }
    if (this.pendingMode === candidate) {
      this.pendingFrames += 1;
    } else {
      this.pendingMode = candidate;
      this.pendingFrames = 1;
    }
    if (this.pendingFrames >= CONFIRM_FRAMES) {
      this.pendingMode = null;
      this.pendingFrames = 0;
      return candidate;
    }
    return this.mode;
  }

  private report(status: TrackerStatus): void {
    if (status.hands !== this.lastReportedStatus.hands || status.mode !== this.lastReportedStatus.mode) {
      this.lastReportedStatus = status;
      this.callbacks.onStatus(status);
    }
  }

  private paintOverlay(landmarksList: NormalizedLandmark[][]): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);

    for (const lm of landmarksList) {
      const palmWidth = distance(lm[INDEX_MCP], lm[PINKY_MCP]);
      const strength = palmWidth > 1e-6 ? clamp01(1 - distance(lm[THUMB_TIP], lm[INDEX_TIP]) / palmWidth / 1.1) : 0;
      const engaged = strength > 1 - PINCH_ENGAGE;

      const thumbX = (1 - lm[THUMB_TIP].x) * width;
      const thumbY = lm[THUMB_TIP].y * height;
      const indexX = (1 - lm[INDEX_TIP].x) * width;
      const indexY = lm[INDEX_TIP].y * height;

      ctx.strokeStyle = engaged ? "#7fe3ff" : "rgba(90, 190, 255, 0.5)";
      ctx.lineWidth = engaged ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(thumbX, thumbY);
      ctx.lineTo(indexX, indexY);
      ctx.stroke();

      ctx.fillStyle = engaged ? "#7fe3ff" : "rgba(90, 190, 255, 0.7)";
      for (const [x, y] of [
        [thumbX, thumbY],
        [indexX, indexY],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, engaged ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
