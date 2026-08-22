// Talks to the optional local companion process in /agent, which is the
// only thing in this project actually allowed to touch the OS (open native
// apps). The browser is sandboxed and can never do that directly — this
// client just relays allowlisted "open <app>" requests over a localhost
// WebSocket, authenticated with a token the user pastes in once.

export type AgentState = "disconnected" | "connecting" | "connected" | "denied" | "error";

export interface AgentInfo {
  platform: string;
  appCount: number;
}

export interface AgentCallbacks {
  onState(state: AgentState): void;
  onInfo?(info: AgentInfo): void;
}

export const DEFAULT_AGENT_URL = "ws://127.0.0.1:8765";
const TOKEN_KEY = "ultron-agent-token";
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 20000;
const COMMAND_TIMEOUT_MS = 5000;

interface PendingCommand {
  resolve: (result: { ok: boolean; message: string }) => void;
}

export class NativeAgentClient {
  private ws: WebSocket | null = null;
  private url: string;
  private callbacks: AgentCallbacks;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyStopped = true;
  private state: AgentState = "disconnected";
  private pending = new Map<string, PendingCommand>();

  constructor(callbacks: AgentCallbacks, url: string = DEFAULT_AGENT_URL) {
    this.callbacks = callbacks;
    this.url = url;
  }

  static getToken(): string {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  }

  static setToken(token: string): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(TOKEN_KEY, token.trim());
  }

  connect(): void {
    this.manuallyStopped = false;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.open();
  }

  disconnect(): void {
    this.manuallyStopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.setState("disconnected");
  }

  get connected(): boolean {
    return this.state === "connected";
  }

  openApp(target: string): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      if (!this.ws || this.state !== "connected") {
        resolve({ ok: false, message: "agent offline" });
        return;
      }
      const id = Math.random().toString(36).slice(2);
      this.pending.set(id, { resolve });
      this.ws.send(JSON.stringify({ type: "command", action: "open", target, id }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ ok: false, message: "timed out" });
        }
      }, COMMAND_TIMEOUT_MS);
    });
  }

  private open(): void {
    if (typeof window === "undefined") return;
    const token = NativeAgentClient.getToken();
    if (!token) {
      this.setState("disconnected");
      return;
    }

    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.setState("error");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: NativeAgentClient.getToken() }));
    };

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (msg.type === "auth_ok") {
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.setState("connected");
        if (typeof msg.platform === "string") {
          this.callbacks.onInfo?.({ platform: msg.platform, appCount: Number(msg.appCount ?? 0) });
        }
      } else if (msg.type === "auth_fail") {
        this.manuallyStopped = true; // don't hammer a rejected token
        this.setState("denied");
        ws.close();
      } else if (msg.type === "result") {
        const id = String(msg.id ?? "");
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.resolve({ ok: Boolean(msg.ok), message: String(msg.message ?? "") });
        }
      }
    };

    ws.onerror = () => {
      this.setState("error");
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.state !== "denied") this.setState("disconnected");
      if (!this.manuallyStopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.manuallyStopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, RECONNECT_MAX_MS);
  }

  private setState(state: AgentState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onState(state);
  }
}
