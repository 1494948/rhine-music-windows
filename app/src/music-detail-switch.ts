/**
 * The detail/lyrics switch — the small luminous bar at the top of an album's
 * detail page.
 *
 * State machine
 * ------------
 *   [detail]  p = 0, album detail in place, bar docked at the top anchor
 *     hover          → the bar lengthens and every light layer blooms (CSS)
 *     click          → [locked]: the idle drift freezes in place and the bar
 *                      reads as a solid mark; the drag stays available
 *     pointerdown    → warm-up runs once, the pane is fetched and mounted
 *     drag down      → p: 0 → 1, detail slides down and fades, lyrics fill in
 *                      from the top, the bar travels to the bottom anchor
 *     drag up        → p: 1 → 0, exact reverse
 *     release        → the drag's own velocity is handed to the spring, so a
 *                      flick carries the bar to the far end on its own; a slow
 *                      release lets p > 0.5 settle to [lyrics] and p <= 0.5
 *                      settle back to [detail]
 *
 * Reading of "点击可锁定状态并停止浮动": the lock freezes the idle float and
 * marks the bar, but it never disables the drag — a control whose only gesture
 * is a click would otherwise have no way back out of its own locked state.
 *
 * Everything animated here is transform/opacity (plus a clip on the karaoke
 * layer); no property that triggers layout is ever written per frame. The
 * travel anchors come from the `--switch-top` / `--switch-bottom` custom
 * properties so the exact docking height stays a CSS decision.
 */

export type DetailSwitchState = "detail" | "lyrics";

export interface DetailSwitchOptions {
  /** `#music-detail`; the bar is appended here and measured against it. */
  host: HTMLElement;
  /** Wrapper whose transform carries the album detail out of the way. */
  surface: HTMLElement;
  /** Anything with a reveal progress, normally the lyrics pane. */
  pane: { setReveal: (p: number) => void };
  /** Runs once, on the first pointerdown, to build the lyrics document. */
  onWarmUp: () => void;
  /** True while another surface owns the gesture. */
  blocked: () => boolean;
  onSettle?: (state: DetailSwitchState) => void;
  onLockChange?: (locked: boolean) => void;
}

/** Drag distance in px that maps to the full 0 → 1 travel. */
const DRAG_TRAVEL = 320;
/** Below this the gesture is a click, not a drag. */
const TAP_SLOP = 4;
/** Settle spring; snappier than the lyrics scroll so the switch feels direct. */
const STIFFNESS = 118;
const DAMPING = 19;
/** Progress per second above which a release is a throw, not a placement. */
const FLICK_SPEED = 1.1;
/** Ceiling for the seeded release velocity, in progress per second. */
const MAX_FLICK = 2.6;
/** Fastest and slowest sample interval trusted when reading drag velocity. */
const MIN_SAMPLE = 0.008;
const MAX_SAMPLE = 0.2;
const HOST_INSET_TOP = 84;
const HOST_INSET_BOTTOM = 68;
/** How far the album detail slides down as it fades out. */
const SURFACE_SHIFT = 64;

export class DetailSwitch {
  readonly element: HTMLButtonElement;

  private readonly options: DetailSwitchOptions;
  private progress = 0;
  private settled: DetailSwitchState = "detail";
  private lockActive = false;
  private dragging = false;
  private pointerId = -1;
  private startY = 0;
  private startProgress = 0;
  private moved = false;
  private warmed = false;
  private animating = false;
  private frame = 0;
  private lastFrameTime = 0;
  private velocity = 0;
  private settleTarget = 0;
  /** Progress per second, measured during the drag so a flick can be thrown. */
  private dragVelocity = 0;
  private lastMoveTime = 0;
  private travel = 1;
  private topAnchor = HOST_INSET_TOP;
  private reduced = false;
  private readonly onPointerDown: (event: PointerEvent) => void;
  private readonly onPointerMove: (event: PointerEvent) => void;
  private readonly onPointerUp: (event: PointerEvent) => void;
  private readonly onPointerCancel: () => void;
  private readonly onKeyDown: (event: KeyboardEvent) => void;

  constructor(options: DetailSwitchOptions) {
    this.options = options;
    const element = document.createElement("button");
    element.type = "button";
    element.id = "detail-switch";
    element.className = "detail-switch";
    // A slider is the honest role: one axis, two settled values, draggable.
    element.setAttribute("role", "slider");
    element.setAttribute("aria-orientation", "vertical");
    element.setAttribute("aria-label", "专辑详情与歌词切换");
    element.setAttribute("aria-valuemin", "0");
    element.setAttribute("aria-valuemax", "1");
    element.setAttribute("aria-valuenow", "0");
    element.setAttribute("aria-valuetext", "专辑详情");
    element.title = "向下拖动查看歌词 · 点击锁定浮动";
    element.innerHTML =
      '<span class="detail-switch-halo" aria-hidden="true"></span><span class="detail-switch-glow" aria-hidden="true"></span><span class="detail-switch-core" aria-hidden="true"></span>';
    options.host.append(element);
    this.element = element;

    this.onPointerDown = (event) => this.pointerDown(event);
    this.onPointerMove = (event) => this.pointerMove(event);
    this.onPointerUp = (event) => this.pointerUp(event);
    this.onPointerCancel = () => this.pointerCancel();
    this.onKeyDown = (event) => this.keyDown(event);
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointercancel", this.onPointerCancel);
    // A capture stolen by another element (a scroll takeover, a lost window)
    // reports here rather than as a pointerup, so the drag has to end here too.
    element.addEventListener("lostpointercapture", this.onPointerCancel);
    element.addEventListener("keydown", this.onKeyDown);
    this.layout();
  }

  get open() {
    return this.settled === "lyrics";
  }

  get locked() {
    return this.lockActive;
  }

  get dragProgress() {
    return this.progress;
  }

  /** Re-reads the dock anchors. Call after the detail content changes size. */
  layout() {
    const style = getComputedStyle(this.options.host);
    const top = parseFloat(style.getPropertyValue("--switch-top")) || HOST_INSET_TOP;
    const bottom = parseFloat(style.getPropertyValue("--switch-bottom")) || HOST_INSET_BOTTOM;
    const height = this.options.host.clientHeight;
    this.topAnchor = top;
    const bottomAnchor = Math.max(top + 24, height - bottom);
    this.travel = Math.max(1, bottomAnchor - top);
    this.apply(this.progress);
  }

  setReduced(reduced: boolean) {
    this.reduced = reduced;
    this.element.classList.toggle("reduce-motion", reduced);
    if (reduced && this.animating) {
      const target = this.progress >= 0.5 ? 1 : 0;
      this.apply(target);
      this.finishSettle(target);
    }
  }

  showLyrics() {
    this.animateTo(1);
  }

  showDetail() {
    this.animateTo(0);
  }

  /** Returns false when the app should keep its own Enter handling. */
  toggle(): boolean {
    this.animateTo(this.settled === "lyrics" ? 0 : 1);
    return true;
  }

  /** Called when the open album changed, so the pane can be re-anchored. */
  syncAlbum() {
    this.layout();
  }

  /**
   * Returns to the album detail without animating, used when the detail page
   * closes so the next album does not open onto a previous album's lyrics.
   */
  reset() {
    this.animating = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.velocity = 0;
    this.dragVelocity = 0;
    this.dragging = false;
    this.pointerId = -1;
    this.element.classList.remove("dragging");
    this.apply(0);
    this.settled = "detail";
    this.element.setAttribute("aria-valuenow", "0");
    this.element.setAttribute("aria-valuetext", "专辑详情");
  }

  dispose() {
    this.animating = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.element.removeEventListener("pointerup", this.onPointerUp);
    this.element.removeEventListener("pointercancel", this.onPointerCancel);
    this.element.removeEventListener("lostpointercapture", this.onPointerCancel);
    this.element.removeEventListener("keydown", this.onKeyDown);
    this.element.remove();
  }

  private warmUp() {
    if (this.warmed) return;
    this.warmed = true;
    this.options.onWarmUp();
  }

  private pointerDown(event: PointerEvent) {
    if (event.button !== 0 || this.options.blocked()) return;
    // Re-measure here as well as on show/resize: the detail page is built while
    // still hidden, so the first measurement can only be trusted once visible.
    this.layout();
    // Starts the one-shot lyrics warm-up; anything measurable happens before
    // the first frame of the drag.
    this.warmUp();
    this.animating = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.dragging = true;
    this.moved = false;
    this.dragVelocity = 0;
    this.lastMoveTime = 0;
    this.pointerId = event.pointerId;
    this.startY = event.clientY;
    this.startProgress = this.progress;
    this.element.classList.add("dragging");
    // The bar is narrow; without capture the drag is lost the moment the
    // pointer leaves it, which is immediately.
    this.element.setPointerCapture(event.pointerId);
  }

  private pointerMove(event: PointerEvent) {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    const delta = event.clientY - this.startY;
    if (!this.moved && Math.abs(delta) < TAP_SLOP) return;
    this.moved = true;
    // A comfortable drag distance rather than the full dock travel: the bar's
    // own glide to the far anchor carries the rest of the motion.
    const next = clamp(this.startProgress + delta / DRAG_TRAVEL);
    const now = event.timeStamp || performance.now();
    const elapsed = this.lastMoveTime
      ? Math.min((now - this.lastMoveTime) / 1000, MAX_SAMPLE)
      : 0;
    this.lastMoveTime = now;
    if (elapsed > MIN_SAMPLE) {
      // Smoothed, so a single jittery sample cannot fling the bar on release.
      // Sampling here rather than at release time is what makes a flick work:
      // by the time pointerup arrives the pointer has already stopped moving.
      const instant = (next - this.progress) / elapsed;
      this.dragVelocity = this.dragVelocity * 0.6 + instant * 0.4;
    }
    this.apply(next);
  }

  private pointerUp(event: PointerEvent) {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    const wasDrag = this.moved;
    const velocity = this.dragVelocity;
    this.endDrag();
    if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
    if (wasDrag) this.animateTo(this.releaseTarget(velocity), velocity);
    else this.setLocked(!this.lockActive);
  }

  /**
   * Where a released drag lands. A throw decides on its own: a quick flick from
   * just past halfway should carry the bar all the way to the far end, which is
   * what makes the gesture feel thrown rather than dropped. Anything gentler
   * falls back to the nearer end.
   */
  private releaseTarget(velocity: number) {
    if (velocity > FLICK_SPEED) return 1;
    if (velocity < -FLICK_SPEED) return 0;
    return this.progress > 0.5 ? 1 : 0;
  }

  private pointerCancel() {
    if (!this.dragging) return;
    this.endDrag();
    // A cancelled gesture settles where it is; it never toggles the lock.
    this.animateTo(this.progress > 0.5 ? 1 : 0);
  }

  private endDrag() {
    this.dragging = false;
    this.pointerId = -1;
    this.element.classList.remove("dragging");
  }

  private keyDown(event: KeyboardEvent) {
    let target: number | undefined;
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      this.toggle();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "End") target = 1;
    else if (event.key === "ArrowUp" || event.key === "Home") target = 0;
    if (target === undefined) return;
    // Arrow keys must not reach the archive's album stepping while the bar has
    // focus, otherwise one press would both scroll the lyrics and change album.
    event.preventDefault();
    event.stopPropagation();
    this.animateTo(target);
  }

  private setLocked(next: boolean) {
    if (this.lockActive === next) return;
    this.lockActive = next;
    this.element.classList.toggle("locked", next);
    this.element.setAttribute(
      "title",
      next ? "已锁定浮动 · 再次点击解锁" : "向下拖动查看歌词 · 点击锁定浮动",
    );
    this.options.onLockChange?.(next);
  }

  private animateTo(target: number, velocity = 0) {
    this.warmUpIfSettlingToLyrics(target);
    if (this.reduced) {
      this.apply(target);
      this.finishSettle(target);
      return;
    }
    this.settleTarget = target;
    this.animating = true;
    // Seeding the spring with the drag's own velocity is the difference between
    // "the bar arrives" and "the bar was thrown": it keeps the momentum the hand
    // gave it, and the spring's damping takes that momentum back out.
    this.velocity = clampVelocity(velocity);
    this.lastFrameTime = 0;
    if (!this.frame) this.frame = requestAnimationFrame(this.stepSettle);
  }

  private stepSettle = (timestamp: number) => {
    if (!this.animating) {
      this.frame = 0;
      return;
    }
    const delta = this.lastFrameTime ? Math.min((timestamp - this.lastFrameTime) / 1000, 1 / 30) : 1 / 60;
    this.lastFrameTime = timestamp;
    const target = this.settleTarget;
    this.velocity += (target - this.progress) * STIFFNESS * delta;
    this.velocity *= Math.exp(-DAMPING * delta);
    const next = this.progress + this.velocity * delta;
    if (Math.abs(target - next) < 0.002 && Math.abs(this.velocity) < 0.02) {
      this.apply(target);
      this.finishSettle(target);
      return;
    }
    this.apply(next);
    this.frame = requestAnimationFrame(this.stepSettle);
  };

  /** Opening the lyrics without a preceding drag still needs the document. */
  private warmUpIfSettlingToLyrics(target: number) {
    if (target >= 0.5) this.warmUp();
  }

  private finishSettle(target: number) {
    this.animating = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const state: DetailSwitchState = target >= 0.5 ? "lyrics" : "detail";
    if (state === this.settled) return;
    this.settled = state;
    this.element.setAttribute("aria-valuenow", state === "lyrics" ? "1" : "0");
    this.element.setAttribute("aria-valuetext", state === "lyrics" ? "歌词" : "专辑详情");
    this.options.onSettle?.(state);
  }

  /** The single writer for every property that changes while dragging. */
  private apply(p: number) {
    const next = clamp(p);
    this.progress = next;
    this.element.style.transform = `translate3d(-50%, ${(this.topAnchor + next * this.travel).toFixed(2)}px, 0)`;
    const surface = this.options.surface;
    if (next <= 0.0001) {
      // Leaving the steady detail state untouched matters: a transform here
      // would turn the reading column into its own stacking context and change
      // how the tab bar's backdrop blur samples the page behind it.
      surface.style.transform = "";
      surface.style.opacity = "";
      surface.inert = false;
    } else {
      surface.style.transform = `translate3d(0, ${(next * SURFACE_SHIFT).toFixed(2)}px, 0)`;
      surface.style.opacity = (1 - next).toFixed(4);
      // Past the halfway point the detail is on its way out; leaving its
      // controls tabbable would let focus land on invisible buttons.
      surface.inert = next > 0.5;
    }
    this.options.pane.setReveal(next);
    if (this.dragging) this.element.setAttribute("aria-valuenow", next.toFixed(2));
  }
}

function clamp(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Caps the velocity handed to the settle spring. `apply` clamps the position to
 * the travel anyway, so an over-fast sample could only ever waste frames
 * saturating at the end — never overshoot past it.
 */
function clampVelocity(value: number) {
  if (!Number.isFinite(value)) return 0;
  return value > MAX_FLICK ? MAX_FLICK : value < -MAX_FLICK ? -MAX_FLICK : value;
}
