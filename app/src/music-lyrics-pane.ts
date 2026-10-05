import {
  EMPTY_LYRICS,
  charTimeline,
  findActiveLine,
  karaokeClip,
  lineEndTime,
  splitChars,
  type LyricsChar,
  type LyricsDocument,
} from "./music-lyrics.ts";

/**
 * The lyrics surface. It is deliberately built only when someone asks to see
 * it: opening an album leaves this class without a single DOM node, and the
 * first `pointerdown` on the bar is what triggers `prepare()`.
 *
 * Per frame the pane writes exactly two things — the track's `--shift` and the
 * active line's `--p` — and only classes change when the active line does.
 * Nothing here reflows text or allocates per frame while playing.
 */

export interface LyricsPaneTrack {
  trackId: string;
  title: string;
  artist: string;
}

export interface LyricsPaneOptions {
  /** Reads one track's lyrics. Called at most once per track id. */
  load: (trackId: string) => Promise<LyricsDocument>;
  /** The track that should be shown; re-read whenever the pane opens. */
  current: () => LyricsPaneTrack | undefined;
  /** Reported when a fetch fails, so the app can toast it once. */
  onError?: (error: unknown) => void;
}

/** Line pitch in px; the CSS custom property mirrors this value. */
const LINE_HEIGHT = 52;
/** Beyond this many lines only a window around the active one stays mounted. */
const VIRTUALIZE_ABOVE = 200;
const WINDOW_HALF = 60;
/** Spring constants for the scroll, tuned to settle in roughly 450 ms. */
const STIFFNESS = 88;
const DAMPING = 17;

export class LyricsPane {
  readonly element: HTMLElement;
  private readonly track: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly headLabel: HTMLElement;
  private readonly note: HTMLElement;
  private readonly options: LyricsPaneOptions;
  private readonly nodes = new Map<number, HTMLElement>();

  private lyrics: LyricsDocument = EMPTY_LYRICS;
  private info?: LyricsPaneTrack;
  private activeNode?: HTMLElement;
  private activeIndex = -1;
  /** Cached per-character timings for the active line, rebuilt on line change. */
  private timeline: LyricsChar[] = [];
  private glyphs: string[] = [];
  private windowStart = -1;
  private windowCount = 0;
  private viewportHeight = 0;
  private shift = 0;
  private velocity = 0;
  private clock = 0;
  private frame = 0;
  private lastFrameTime = 0;
  private running = false;
  private reduced = false;
  private reveal = 0;
  private ready = false;
  private observer?: ResizeObserver;

  constructor(host: HTMLElement, options: LyricsPaneOptions) {
    this.options = options;
    const element = document.createElement("div");
    element.id = "music-lyrics-pane";
    element.className = "music-lyrics";
    element.hidden = true;
    element.setAttribute("aria-label", "歌词");
    element.innerHTML = `<div class="lyrics-head"><small>LYRICS <i>／</i> 歌词</small><span class="lyrics-credit"></span></div>
      <div class="lyrics-viewport"><div class="lyrics-track-line"></div></div>
      <p class="lyrics-note" role="status"></p>`;
    host.append(element);
    this.element = element;
    this.track = element.querySelector<HTMLElement>(".lyrics-track-line")!;
    this.viewport = element.querySelector<HTMLElement>(".lyrics-viewport")!;
    this.headLabel = element.querySelector<HTMLElement>(".lyrics-credit")!;
    this.note = element.querySelector<HTMLElement>(".lyrics-note")!;
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(() => this.measure());
      this.observer.observe(this.viewport);
    }
  }

  /** True once a document has been parsed and its lines mounted. */
  get prepared() {
    return this.ready;
  }

  get trackId() {
    return this.info?.trackId;
  }

  get lyricsReady() {
    return this.ready && this.lyrics.lines.length > 0;
  }

  /** The pane is display:none until revealed, so height is read on demand. */
  measure() {
    this.viewportHeight = this.viewport.clientHeight || this.element.clientHeight - 96;
  }

  /**
   * One-shot warm-up: fetch, parse and mount. Repeat calls while a fetch is in
   * flight share the same promise, so a second pointerdown never doubles work.
   */
  prepare(): Promise<void> {
    const info = this.options.current();
    if (!info) return Promise.resolve();
    if (this.ready && this.info?.trackId === info.trackId) {
      this.syncCredit();
      return Promise.resolve();
    }
    return this.load(info);
  }

  /** Switches the shown track; a no-op when it is already the current one. */
  setTrack(info: LyricsPaneTrack | undefined) {
    if (!info) {
      this.clear();
      return;
    }
    if (this.info?.trackId === info.trackId) {
      this.info = info;
      this.syncCredit();
      return;
    }
    this.clear();
    this.info = info;
    if (this.reveal > 0) void this.prepare();
    else this.syncCredit();
  }

  private async load(info: LyricsPaneTrack) {
    this.info = info;
    this.syncCredit();
    if (!this.ready) this.setNote("正在读取歌词…");
    let parsed = EMPTY_LYRICS;
    try {
      parsed = await this.options.load(info.trackId);
    } catch (error) {
      this.options.onError?.(error);
      if (this.info?.trackId === info.trackId) this.setNote("读取歌词失败，可稍后重试。");
      return;
    }
    // An album or track switch can land while the request is in flight.
    if (this.info?.trackId !== info.trackId) return;
    this.lyrics = parsed;
    this.build();
  }

  /** Mounts the document; the only place line nodes are created. */
  private build() {
    const { lines } = this.lyrics;
    this.nodes.clear();
    this.activeNode = undefined;
    this.track.textContent = "";
    this.activeIndex = -1;
    this.shift = 0;
    this.velocity = 0;
    this.windowStart = -1;
    this.windowCount = 0;
    this.track.style.setProperty("--line-h", `${LINE_HEIGHT}px`);
    this.track.style.setProperty("--shift", "0px");
    if (!lines.length) {
      this.ready = false;
      this.setNote(
        this.lyrics.source === "none"
          ? "这首歌没有内嵌歌词。把同名的 .lrc 文件放在音乐文件旁边，重新扫描后即可显示。"
          : "歌词内容为空。",
      );
      return;
    }
    this.ready = true;
    this.setNote("");
    this.element.classList.toggle("lyrics-unsynced", !this.lyrics.synced);
    this.measure();
    this.mountWindow(0);
    // Paints the first frame now, so the pane never appears uniformly dim while
    // it waits for the clock to advance.
    if (this.lyrics.synced) this.markActive(findActiveLine(this.lyrics, this.clock));
  }

  /**
   * Mounts only the lines near `center` for very long documents. Positions are
   * absolute, so mounting a subset never shifts the layout.
   */
  private mountWindow(center: number) {
    const total = this.lyrics.lines.length;
    const start = total > VIRTUALIZE_ABOVE ? Math.max(0, center - WINDOW_HALF) : 0;
    const count = total > VIRTUALIZE_ABOVE ? Math.min(total, center + WINDOW_HALF) - start : total;
    if (start === this.windowStart && count === this.windowCount) return;
    this.windowStart = start;
    this.windowCount = count;
    this.nodes.clear();
    this.activeNode = undefined;
    const fragment = document.createDocumentFragment();
    for (let index = start; index < start + count; index++) {
      const line = this.lyrics.lines[index];
      const node = document.createElement("div");
      node.className = "lyric-line";
      node.dataset.index = String(index);
      node.style.setProperty("--i", String(index));
      // Two stacked copies: the dim base and the accent layer clipped to the
      // karaoke sweep. Only the clip fraction changes while playing.
      node.innerHTML = '<span class="lyric-main"></span><span class="lyric-fill" aria-hidden="true"></span>';
      const main = node.querySelector<HTMLElement>(".lyric-main")!;
      main.textContent = line.text;
      node.querySelector<HTMLElement>(".lyric-fill")!.textContent = line.text;
      fragment.append(node);
      this.nodes.set(index, node);
    }
    this.track.textContent = "";
    this.track.append(fragment);
  }

  private syncCredit() {
    const info = this.info;
    this.headLabel.textContent = info ? `${info.title}${info.artist ? ` · ${info.artist}` : ""}` : "";
  }

  private setNote(text: string) {
    this.note.textContent = text;
    this.note.hidden = !text;
    this.element.classList.toggle("lyrics-empty", !!text);
  }

  /** Feed the playback clock. Called from the existing player subscription. */
  setClock(seconds: number) {
    this.clock = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    // While the bar is held still, the reveal animation owns the loop, and a
    // seek from elsewhere still has to repaint.
    if (!this.running && this.reveal > 0.001) this.step(0);
  }

  /**
   * Drag progress of the bar, 0 = album detail, 1 = lyrics. Drives the
   * per-line stagger so the pane fills in from the top down.
   */
  setReveal(p: number) {
    const next = Math.max(0, Math.min(1, p));
    if (next === this.reveal) return;
    const wasHidden = this.reveal <= 0.001;
    this.reveal = next;
    this.element.style.setProperty("--reveal", next.toFixed(3));
    this.element.style.opacity = String(next);
    this.element.style.transform = `translate3d(0, ${((1 - next) * 42).toFixed(2)}px, 0)`;
    if (next > 0.001) {
      this.element.hidden = false;
      if (wasHidden) this.measure();
      if (!this.running) this.start();
    } else {
      this.element.hidden = true;
      this.stop();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = 0;
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  setReduced(reduced: boolean) {
    this.reduced = reduced;
    this.element.classList.toggle("reduce-motion", reduced);
  }

  clear() {
    this.stop();
    this.lyrics = EMPTY_LYRICS;
    this.info = undefined;
    this.ready = false;
    this.activeIndex = -1;
    this.activeNode = undefined;
    this.nodes.clear();
    this.timeline = [];
    this.glyphs = [];
    this.windowStart = -1;
    this.windowCount = 0;
    this.track.textContent = "";
    this.headLabel.textContent = "";
    this.setNote("");
  }

  dispose() {
    this.stop();
    this.observer?.disconnect();
    this.observer = undefined;
    this.element.remove();
  }

  private tick = (timestamp: number) => {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.tick);
    const delta = this.lastFrameTime ? Math.min((timestamp - this.lastFrameTime) / 1000, 1 / 30) : 0;
    this.lastFrameTime = timestamp;
    this.step(delta);
  };

  private step(delta: number) {
    if (!this.ready || !this.lyrics.lines.length) return;
    const index = findActiveLine(this.lyrics, this.clock);
    if (index !== this.activeIndex) {
      if (index >= 0 && (
        index < this.windowStart + WINDOW_HALF / 2 ||
        index >= this.windowStart + this.windowCount - WINDOW_HALF / 2
      )) this.mountWindow(index);
      this.markActive(index);
    }
    const line = index < 0 ? 0 : index;
    const target = this.viewportHeight * 0.5 - (line * LINE_HEIGHT + LINE_HEIGHT / 2);
    if (this.reduced) {
      this.shift = target;
      this.velocity = 0;
    } else if (delta > 0) {
      // A spring rather than a tween: a seek and a natural advance land with
      // the same feel, and a stalled frame resumes instead of jumping.
      this.velocity += (target - this.shift) * STIFFNESS * delta;
      this.velocity *= Math.exp(-DAMPING * delta);
      this.shift += this.velocity * delta;
      if (Math.abs(target - this.shift) < 0.05 && Math.abs(this.velocity) < 0.05) {
        this.shift = target;
        this.velocity = 0;
      }
    } else {
      this.shift = target;
    }
    this.track.style.setProperty("--shift", `${this.shift.toFixed(2)}px`);
    this.paintKaraoke(index);
  }

  /** Class changes are batched to the moment the active line actually changes. */
  private markActive(index: number) {
    this.activeNode = undefined;
    this.timeline = [];
    this.glyphs = [];
    if (index >= 0) {
      const line = this.lyrics.lines[index];
      this.glyphs = splitChars(line.text);
      // Character timings are derived once per line, never per frame.
      this.timeline = charTimeline(this.lyrics, index, this.glyphs);
    }
    for (const [own, node] of this.nodes) {
      const distance = index < 0 ? 99 : Math.abs(own - index);
      // One attribute and one custom property per line: the stylesheet turns the
      // distance into opacity, blur and emphasis, so this stays two writes.
      node.dataset.d =
        distance === 0 ? "0" : distance <= 2 ? "near" : distance <= 6 ? "mid" : "far";
      // Lines beyond the readable band skip the filter entirely rather than
      // paying for `blur(0px)`, which still allocates a filter layer.
      node.style.setProperty(
        "--blur",
        distance === 0 ? "none" : distance <= 3 ? "blur(1.4px)" : distance <= 9 ? "blur(2.6px)" : "none",
      );
      node.style.setProperty("--p", "0");
      if (own === index) this.activeNode = node;
    }
    this.activeIndex = index;
  }

  private paintKaraoke(index: number) {
    const node = this.activeNode;
    if (!node || index < 0) return;
    // Unsynced lyrics have no clock of their own; they read at full strength so
    // the pane still works as a plain text view.
    if (!this.lyrics.synced || !this.glyphs.length || !this.timeline.length) {
      node.style.setProperty("--p", "1");
      return;
    }
    const line = this.lyrics.lines[index];
    const end = lineEndTime(this.lyrics, index);
    node.style.setProperty("--p", karaokeClip(this.glyphs, this.timeline, this.clock).toFixed(4));
    node.style.setProperty(
      "--line-p",
      Math.max(0, Math.min(1, (this.clock - line.time) / Math.max(0.2, end - line.time))).toFixed(4),
    );
  }
}
