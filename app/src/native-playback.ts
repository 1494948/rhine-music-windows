/**
 * Native playback client.
 *
 * Primary channel: localhost HTTP control API injected by RhineMusic.exe
 *   window.__rhinePlayerControl = { port, base }
 * Fallback: WebView2 window.chrome.webview.postMessage
 */

export type NativePlayerEvent =
  | { type: "ready"; backend: string; exclusive?: boolean; dsd?: boolean; formats?: string[] }
  | { type: "loading"; trackId?: string | null }
  | { type: "playing"; trackId?: string | null }
  | { type: "paused"; trackId?: string | null }
  | { type: "stopped" }
  | { type: "eof"; trackId?: string | null }
  | { type: "error"; trackId?: string | null; message: string }
  | {
      type: "position";
      trackId?: string | null;
      time: number;
      duration: number;
      paused: boolean;
    }
  | { type: "devices"; devices: { id: string; name: string }[] }
  | { type: "exclusive"; value: boolean }
  | { type: "device"; id: string | null }
  | { type: "log"; message: string }
  | { type: "property"; name: string; value: unknown };

type Listener = (event: NativePlayerEvent) => void;

interface WebView2Host {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    handler: (event: { data: unknown }) => void,
  ): void;
}

declare global {
  interface Window {
    __rhinePlayerControl?: { port: number; base: string } | null;
    chrome?: { webview?: WebView2Host };
  }
}

/**
 * The browser global, or null when there is no browser.
 *
 * Every access in this module is to a global the WebView2 shell guarantees, so
 * the guard is not about the shipped application. It is about everything else:
 * a module that reads `window` at construction time throws under plain Node, and
 * a module that throws on construction cannot be loaded by the player's own
 * check. `transport` already has a `"none"` state for exactly this case.
 */
const hostWindow = (): (Window & typeof globalThis) | null =>
  typeof window === "undefined" ? null : window;

export class NativePlaybackClient {
  private listeners = new Set<Listener>();
  private host: WebView2Host | null = null;
  private bound = false;
  private controlBase: string | null = null;
  private lastError = "";

  constructor() {
    this.refresh();
    const view = hostWindow();
    if (!view) return;
    view.addEventListener("focus", () => this.refresh());
    view.document.addEventListener("DOMContentLoaded", () => this.refresh(), {
      once: true,
    });
    const timer = view.setInterval(() => {
      this.refresh();
      if (this.controlBase || this.host) view.clearInterval(timer);
    }, 150);
    view.setTimeout(() => view.clearInterval(timer), 8000);
  }

  get available(): boolean {
    this.refresh();
    return !!(this.controlBase || this.host);
  }

  get transport(): "http" | "webview" | "none" {
    if (this.controlBase) return "http";
    if (this.host) return "webview";
    return "none";
  }

  private refresh(): boolean {
    const view = hostWindow();
    if (!view) return false;
    const control = view.__rhinePlayerControl;
    if (control?.base) this.controlBase = control.base;

    const host = view.chrome?.webview ?? null;
    if (host && (!this.bound || this.host !== host)) {
      this.host = host;
      this.bound = true;
      try {
        host.addEventListener("message", (event) => {
          const payload = event.data as NativePlayerEvent;
          if (!payload || typeof payload !== "object") return;
          for (const listener of this.listeners) listener(payload);
        });
      } catch {
        // ignore
      }
    }
    return !!(this.controlBase || this.host);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.refresh();
    return () => this.listeners.delete(listener);
  }

  private postJson(message: Record<string, unknown>): boolean {
    if (!this.refresh() || !this.host) return false;
    try {
      this.host.postMessage(message);
      return true;
    } catch (error) {
      this.lastError = String(error);
      return false;
    }
  }

  private async http(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<boolean> {
    if (!this.refresh() || !this.controlBase) return false;
    try {
      const res = await fetch(this.controlBase + path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        this.lastError = `HTTP ${res.status}`;
        return false;
      }
      return true;
    } catch (error) {
      this.lastError = String(error);
      return false;
    }
  }

  log(message: string): void {
    void this.http("POST", "log", { message }).then((ok) => {
      if (!ok) this.postJson({ type: "log", message });
    });
    // Also emit locally so the UI can show it.
    for (const listener of this.listeners) {
      listener({ type: "log", message });
    }
  }

  async play(trackId: string, url: string, start = 0): Promise<void> {
    const payload = { trackId, url, start };
    const ok = await this.http("POST", "play", payload);
    if (!ok && !this.postJson({ type: "play", ...payload })) {
      this.log(`play failed transport=${this.transport} ${this.lastError}`);
    }
  }

  async pause(): Promise<void> {
    if (!(await this.http("POST", "pause"))) this.postJson({ type: "pause" });
  }

  async resume(): Promise<void> {
    if (!(await this.http("POST", "resume"))) this.postJson({ type: "resume" });
  }

  async toggle(): Promise<void> {
    if (!(await this.http("POST", "toggle"))) this.postJson({ type: "toggle" });
  }

  async stop(): Promise<void> {
    if (!(await this.http("POST", "stop"))) this.postJson({ type: "stop" });
  }

  async seek(seconds: number): Promise<void> {
    if (!(await this.http("POST", "seek", { seconds })))
      this.postJson({ type: "seek", seconds });
  }

  async setVolume(value: number): Promise<void> {
    if (!(await this.http("POST", "volume", { value })))
      this.postJson({ type: "volume", value });
  }

  async setExclusive(value: boolean): Promise<void> {
    if (!(await this.http("POST", "exclusive", { value })))
      this.postJson({ type: "exclusive", value });
  }

  async setDevice(id: string | null): Promise<void> {
    if (!(await this.http("POST", "device", { id })))
      this.postJson({ type: "device", id });
  }

  async sfx(name: string): Promise<void> {
    if (!(await this.http("POST", "sfx", { name })))
      this.postJson({ type: "sfx", name });
  }

  async bgm(action: string, value?: number, enabled?: boolean): Promise<void> {
    const body: Record<string, unknown> = { action };
    if (value !== undefined) body.value = value;
    if (enabled !== undefined) body.enabled = enabled;
    if (!(await this.http("POST", "bgm", body))) this.postJson({ type: "bgm", ...body });
  }

  async listDevices(): Promise<void> {
    if (this.controlBase) {
      try {
        const res = await fetch(this.controlBase + "devices");
        const data = (await res.json()) as {
          devices?: { id: string; name: string }[];
        };
        for (const listener of this.listeners) {
          listener({ type: "devices", devices: data.devices ?? [] });
        }
        return;
      } catch {
        // fall through
      }
    }
    this.postJson({ type: "list-devices" });
  }

  async ping(): Promise<void> {
    if (this.controlBase) {
      try {
        const res = await fetch(this.controlBase + "ping");
        const data = await res.json();
        for (const listener of this.listeners) {
          listener({ type: "ready", backend: data.backend ?? "libmpv", dsd: true });
        }
        return;
      } catch {
        // fall through
      }
    }
    this.postJson({ type: "ping" });
  }

  describe(): string {
    this.refresh();
    return `transport=${this.transport} control=${this.controlBase ?? "none"} host=${!!this.host} err=${this.lastError || "-"}`;
  }
}

export function resolveTrackUrl(audioUrl: string): string {
  if (/^https?:\/\//i.test(audioUrl)) return audioUrl;
  const origin = hostWindow()?.location?.origin;
  // Without an origin a relative path has nothing to resolve against, so it is
  // passed through unchanged rather than guessed at.
  return origin ? new URL(audioUrl, origin).toString() : audioUrl;
}

let client: NativePlaybackClient | null = null;

export function getNativePlayback(): NativePlaybackClient {
  if (!client) client = new NativePlaybackClient();
  return client;
}

export type NativeKernelPrefs = {
  exclusive: boolean;
  deviceId: string | null;
  backend: "native-libmpv" | "browser" | "unknown";
};

export function loadNativeKernelPrefs(): NativeKernelPrefs {
  try {
    const raw = localStorage.getItem("rhine-audio-kernel");
    if (raw)
      return {
        exclusive: false,
        deviceId: null,
        backend: "unknown",
        ...JSON.parse(raw),
      };
  } catch {
    // ignore
  }
  return { exclusive: false, deviceId: null, backend: "unknown" };
}

export function saveNativeKernelPrefs(prefs: NativeKernelPrefs): void {
  try {
    localStorage.setItem("rhine-audio-kernel", JSON.stringify(prefs));
  } catch {
    // ignore
  }
}
