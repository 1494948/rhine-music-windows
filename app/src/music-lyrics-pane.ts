import {
  EMPTY_LYRICS,
  charTimeline,
  findActiveLine,
  karaokeClip,
  lineEndTime,
  splitChars,
  splitUnits,
  unitReveal,
  type LyricsChar,
  type LyricsDocument,
  type LyricsUnit,
} from "./music-lyrics.ts";
import { applyLyricTokens, type LyricsSettings } from "./lyrics-settings.ts";

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

/**
 * Everything the 「歌词」 settings module can change at runtime lives in
 * `lyrics-settings.ts`, which owns the single token list shared with the in-panel
 * preview. The renderer only needs three of those values back in JavaScript: the
 * row pitch positions every line and drives the scroll target, the blur
 * multiplier is applied where the per-line `--blur` values are written, and the
 * delay is folded into the clock.
 */
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
  /** Row pitch, kept in step with `--line-h` by setStyle. */
  private pitch = LINE_HEIGHT;
  /** Blur tier multiplier; 1 is the shipped look. */
  private blurScale = 1;
  /** Lyric offset against the audio clock, in seconds. */
  private delay = 0;
  /** Longest gap that still reads as "lyrics are coming"; beyond it, dots. */
  private interludeGap = 6;
  private interludeOn = false;
  /**
   * The active line, decomposed into per-unit spans.
   *
   * Only the singing line is decomposed: the other fifty-nine lines in the
   * window stay a single text node each, so the DOM cost is one line's worth of
   * spans rather than a document's. `unitOwner` is what keeps a re-apply of the
   * settings (which re-enters markActive) from rebuilding spans the line
   * already has — a rebuild would reset every `--g` to 0 and the line would
   * visibly re-settle on a settings change.
   */
  private unitOwner?: HTMLElement;
  private units: LyricsUnit[] = [];
  private unitMain: HTMLElement[] = [];
  private unitFill: HTMLElement[] = [];
  /** Last `--g` written per unit, so a frame only writes what actually moved. */
  private unitLast: number[] = [];

  constructor(host: HTMLElement, options: LyricsPaneOptions) {
    this.options = options;
    const element = document.createElement("div");
    element.id = "music-lyrics-pane";
    element.className = "music-lyrics";
    element.hidden = true;
    element.setAttribute("aria-label", "歌词");
    element.innerHTML = `<div class="lyrics-head"><small>LYRICS <i>／</i> 歌词</small><span class="lyrics-credit"></span></div>
      <div class="lyrics-viewport"><div class="lyrics-track-line"></div>
        <div class="lyric-interlude" aria-hidden="true"><i></i><i></i><i></i></div></div>
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
    this.track.style.setProperty("--line-h", `${this.pitch}px`);
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
    // The nodes these arrays point at are about to be discarded.
    this.unitOwner = undefined;
    this.units = [];
    this.unitMain = [];
    this.unitFill = [];
    this.unitLast = [];
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
    // The settings offset is folded in here rather than at every read, so a
    // change takes effect on the next tick without touching the call site.
    const shifted = (Number.isFinite(seconds) ? Math.max(0, seconds) : 0) + this.delay;
    this.clock = Math.max(0, shifted);
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

  /**
   * Apply the 「歌词」 settings. Every visual knob is a custom property written by
   * the shared token list, so a change costs one style write and never a
   * re-mount: the mounted lines re-read them on the next paint. The three values
   * the renderer also needs are handled here — the row pitch has to reach the
   * scroll target, the blur tiers are inline `--blur` values derived in
   * markActive, and the delay is folded into the clock.
   */
  setStyle(settings: LyricsSettings) {
    applyLyricTokens(this.element, settings);
    this.pitch = Math.max(24, settings.pitch);
    this.track.style.setProperty("--line-h", `${this.pitch}px`);
    this.delay = settings.delayMs / 1000;
    this.blurScale = settings.blur;
    this.interludeGap = settings.interludeGap;
    this.measure();
    if (this.ready) this.markActive(this.activeIndex);
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
    this.unitOwner = undefined;
    this.units = [];
    this.unitMain = [];
    this.unitFill = [];
    this.unitLast = [];
    this.setInterlude(false);
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
    this.trackInterlude(index);
    const line = index < 0 ? 0 : index;
    const target = this.viewportHeight * 0.5 - (line * this.pitch + this.pitch / 2);
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

  /**
   * Decides whether the pane is waiting out an instrumental stretch.
   *
   * The waiting state is "the line has finished being sung and the next one is
   * still far away", not "the line started a while ago": the sweep is capped at
   * twelve seconds precisely so a long gap does not hold a line on screen, and
   * hanging the dots off the line's onset would put them up while it is still
   * being sung.
   */
  private trackInterlude(index: number) {
    const next = index < 0 ? this.lyrics.lines[0] : this.lyrics.lines[index + 1];
    this.setInterlude(
      this.lyrics.synced &&
        this.interludeGap > 0 &&
        !!next &&
        (index < 0 || this.clock >= lineEndTime(this.lyrics, index)) &&
        next.time - this.clock > this.interludeGap,
    );
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
      // paying for `blur(0px)`, which still allocates a filter layer. The two
      // in-band tiers are scaled by the settings' blur multiplier, and a
      // multiplier of zero drops the filter altogether.
      const blur =
        distance === 0 || this.blurScale <= 0
          ? "none"
          : distance <= 3
            ? `blur(${(1.4 * this.blurScale).toFixed(2)}px)`
            : distance <= 9
              ? `blur(${(2.6 * this.blurScale).toFixed(2)}px)`
              : "none";
      node.style.setProperty("--blur", blur);
      node.style.setProperty("--p", "0");
      if (own === index) {
        this.activeNode = node;
        this.decompose(node);
      }
    }
    this.activeIndex = index;
  }

  /**
   * Splits the singing line into one span per unit, mirrored across both layers.
   *
   * Both copies have to carry the same `--g`: the accent layer is a second copy
   * of the same text positioned over the base one, so a per-unit offset applied
   * to only one of them would tear the two apart and show as a ghost.
   *
   * The spans are `inline-block` and move by `transform` alone. That is
   * deliberate — animating `font-weight` or `letter-spacing` would change the
   * glyph raster and force a re-shape every frame, which is exactly what the
   * transforms avoid.
   */
  private decompose(node: HTMLElement) {
    if (this.unitOwner === node && this.units.length) return;
    this.unitOwner = node;
    this.units = [];
    this.unitMain = [];
    this.unitFill = [];
    this.unitLast = [];
    const main = node.querySelector<HTMLElement>(".lyric-main");
    const fill = node.querySelector<HTMLElement>(".lyric-fill");
    if (!main || !fill || !this.glyphs.length) return;
    const units = splitUnits(this.glyphs);
    // The units go inside one wrapper per layer rather than straight into it:
    // the accent layer is a `flex` box, and a flex box makes every child its own
    // flex item, which would lay the line out as a single unwrappable row. One
    // block-level item per layer keeps the wrapping identical to the base layer's.
    const base = document.createElement("span");
    base.className = "lyric-units";
    const accent = document.createElement("span");
    accent.className = "lyric-units";
    accent.setAttribute("aria-hidden", "true");
    for (const unit of units) {
      for (const [parent, list] of [
        [base, this.unitMain],
        [accent, this.unitFill],
      ] as const) {
        const span = document.createElement("span");
        span.className = "lyric-unit";
        // 0 rather than 1: the line has only just started, and the units settle
        // into place as they are sung.
        span.style.setProperty("--g", "0");
        span.textContent = unit.text;
        parent.append(span);
        list.push(span);
      }
      this.unitLast.push(-1);
    }
    main.textContent = "";
    fill.textContent = "";
    main.append(base);
    fill.append(accent);
    this.units = units;
  }

  private paintKaraoke(index: number) {
    const node = this.activeNode;
    if (!node || index < 0) return;
    // Unsynced lyrics have no clock of their own; they read at full strength so
    // the pane still works as a plain text view.
    if (!this.lyrics.synced || !this.glyphs.length || !this.timeline.length) {
      node.style.setProperty("--p", "1");
      this.paintUnits(true);
      return;
    }
    // The line's own duration no longer feeds a second readout: the sweep's soft
    // edge is the whole indicator, so only the clip fraction is written.
    node.style.setProperty("--p", karaokeClip(this.glyphs, this.timeline, this.clock).toFixed(4));
    this.paintUnits();
  }

  /**
   * Writes `--g` on the units whose reveal actually moved this frame.
   *
   * A unit spans at least a whole glyph, so in the steady state one, rarely two
   * units change between two frames. Comparing against the last written value
   * turns "one write per unit per frame" into "one write per unit per glyph",
   * which is what makes a per-glyph animation affordable at all.
   */
  private paintUnits(sung = false) {
    const { units } = this;
    if (!units.length) return;
    const values =
      sung || this.reduced ? units.map(() => 1) : unitReveal(units, this.timeline, this.clock);
    for (let index = 0; index < values.length; index++) {
      if (Math.abs(values[index] - this.unitLast[index]) < 0.008) continue;
      this.unitLast[index] = values[index];
      const text = values[index].toFixed(3);
      this.unitMain[index]?.style.setProperty("--g", text);
      this.unitFill[index]?.style.setProperty("--g", text);
    }
  }

  /**
   * Shows or hides the interlude dots by class only.
   *
   * The breathing itself is a CSS animation with no timeline of its own — the
   * pane's job is a single boolean that flips once per gap, not a timer per
   * dot.
   */
  private setInterlude(waiting: boolean) {
    if (waiting === this.interludeOn) return;
    this.interludeOn = waiting;
    this.element.classList.toggle("interlude", waiting);
  }
}
