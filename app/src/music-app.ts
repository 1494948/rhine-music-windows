import "@kitlangton/rolling-number/styles.css";
import "./style.css";
import "./quality-settings.css";
import "./document-decryption.css";
import "./decryption.css";
import "./music.css";
import "./music-navigation-motion.css";
import "./music-navigation-ruler.css";
import "./music-transport-title.css";
import "./music-theme.css";
import "./music-theme-switch.css";
import "./music-archive.css";
import "./music-lyrics-switch.css";
import { DocumentDecryption } from "./document-decryption";
import { ContentTransition, SurfaceTransition } from "./ui-transitions";
import { qualityMarkup, syncQualityUI } from "./quality-settings";
import { ArchiveScene } from "./scene";
import {
  records,
  archiveColumns,
  columnFiles,
  fileLocation,
  setMusicAlbums,
  orderMusicAlbums,
  type MusicSortMode,
} from "./data";
import { fileAtCell, wrap, type ArchiveNavigation } from "./archive-loop";
import {
  normalizeQuality,
  qualityPresets,
  type QualityPreset,
  type RenderQuality,
} from "./render-quality";
import { MusicPlayer, type MusicPlayerState } from "./music-player";
import {
  getNativePlayback,
  loadNativeKernelPrefs,
  saveNativeKernelPrefs,
} from "./native-playback";
import { ModelViewer } from "./model-viewer";
import { TerminalAudio } from "./audio";
import type {
  MusicAlbum,
  MusicGenre,
  MusicLibrary,
  GenreRules,
} from "./music-types";
import { demoAlbums, demoGenres } from "./demo-library";
import { escapeHtml as esc } from "./html";
import { albumTitleMarkup, setupMusicTitleLayout } from "./music-title";
import { setupMusicTextMotion } from "./music-text-motion";
import { setupTransportTitle } from "./music-transport-title";
import { setupMusicTicks } from "./music-ticks";
import { setupMusicRuler } from "./music-ruler";
import { MusicPresentation, type AlbumSelection } from "./music-presentation";
import { MusicTrackFocus } from "./music-track-focus";
import { MusicBoot } from "./music-boot";
import { viewportLayout } from "./viewport-layout";
import {
  albumArchiveMarkup,
  resolveAlbumArchive,
  type AlbumArchiveContext,
  type AlbumArchiveOnline,
} from "./music-archive";
import {
  EMPTY_LYRICS,
  findActiveLine,
  parseLyricsPayload,
  type LyricsDocument,
  type LyricsPayload,
} from "./music-lyrics";
import { LyricsPane, type LyricsPaneTrack } from "./music-lyrics-pane";
import "./lyrics-settings.css";
import {
  applyLyricControl,
  applyLyricPatch,
  applyLyricTokens,
  defaultLyricsSettings,
  loadLyricsSettings,
  lyricGroupKeys,
  lyricPresetPatch,
  lyricsMarkup,
  saveLyricsSettings,
  setLyricPreviewLineCount,
  setLyricPreviewSample,
  syncLyricsUI,
  type LyricPreviewTrack,
} from "./lyrics-settings.ts";
import { DetailSwitch } from "./music-detail-switch";
import { version as appVersion } from "../package.json";
import { normalizeMusicArrayMode, type MusicArrayMode } from "./music-array-layout";
import { mountMusicWheelNavigation } from "./music-wheel-navigation";
import "./music-overview.css";
import { MusicOverviewUI } from "./music-overview-ui";
import { setupMotionLab } from "./music-motion-lab";
import { setupLightingLab } from "./music-lighting-lab";
import type { LightingLabController, LightingLabSettings } from "./music-lighting-lab";
import {
  getMusicMotionSpeed,
  normalizeMusicMotionSpeed,
  onMusicMotionSpeedChange,
  setMusicMotionSpeed,
} from "./music-motion-settings";
import { normalizeSongTransition, type SongTransitionMode } from "./music-song-transition";

type Theme = "day" | "night";
type Panel = "library" | "search" | "settings" | null;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const svg = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  play: svg('<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1"/>'),
  search: svg(
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  ),
  settings: svg(
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="var(--surface)"/><circle cx="15" cy="17" r="2.5" fill="var(--surface)"/>',
  ),
  folder: svg('<path d="M3 7V5h6l2 2h10v13H3Z"/>'),
};
const read = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
const lightingLab = new URLSearchParams(location.search).get("lab") !== "0";
const preferences = {
  ...{
    theme: "day" as Theme,
    sortMode: "genre" as MusicSortMode,
    arrayMode: "filled" as MusicArrayMode,
    rememberColumnPosition: true,
    quality: "original" as QualityPreset,
    reduced: false,
    volume: 0.65,
    // 留空直到读取旧偏好：默认值会盖掉用户此前的"关闭淡入淡出"选择。
    songTransition: undefined as SongTransitionMode | undefined,
    bgm: true,
    bgmVolume: 0.45,
    sound: true,
    soundVolume: 0.55,
    idleStop: true,
    glassFrost: 100,
    sharpen: 50,
    renderQuality: undefined as RenderQuality | undefined,
    developerMode: false,
    motionDebug: false,
    motionSpeed: 1,
    lighting: undefined as Partial<LightingLabSettings> | undefined,
  },
  ...read<
    Partial<{
      theme: Theme;
      sortMode: MusicSortMode;
      arrayMode: MusicArrayMode;
      rememberColumnPosition: boolean;
      quality: QualityPreset;
      reduced: boolean;
      volume: number;
      songFade: boolean;
      songTransition: SongTransitionMode;
      bgm: boolean;
      bgmVolume: number;
      sound: boolean;
      soundVolume: number;
      idleStop: boolean;
      glassFrost: number;
      sharpen: number;
      renderQuality: RenderQuality;
      developerMode: boolean;
      motionDebug: boolean;
      motionSpeed: number;
      lighting: Partial<LightingLabSettings>;
    }>
  >("rhine-music-preferences", {}),
};
// The shelf used to ship with the refraction capture at 100% and a
// full-resolution bokeh; measured on an Intel iGPU that pair costs about 14 ms of
// every frame. Only installations that never touched the quality controls still
// carry exactly that pair, so migrate them to the new default and leave every
// deliberate choice alone.
const legacyShelfDefault: RenderQuality = {
  scale: 100,
  pixelRatio: 1.5,
  antialias: "off",
  shadows: 2048,
  aoSamples: 32,
  aoResolution: 1,
  depthOfField: 100,
  transmission: 1,
  anisotropy: 16,
};
const storedQuality = preferences.renderQuality;
const untouchedQuality =
  !storedQuality ||
  (Object.keys(legacyShelfDefault) as (keyof RenderQuality)[]).every(
    (key) => storedQuality[key] === legacyShelfDefault[key],
  );
let renderQuality = normalizeQuality(
  untouchedQuality
    ? qualityPresets.original
    : storedQuality || qualityPresets[preferences.quality],
);
if (!["day", "night"].includes(preferences.theme)) {
  preferences.theme = "day";
  save("rhine-music-preferences", preferences);
}
// Legacy defaults (0.18 / 0.22) sit under the source material's own -20 dB peaks
// and read as silence on typical desktop volume. Migrate only that exact pair.
if (preferences.bgmVolume === 0.18 && preferences.soundVolume === 0.22) {
  preferences.bgmVolume = 0.45;
  preferences.soundVolume = 0.55;
  save("rhine-music-preferences", preferences);
}
if (!Object.hasOwn(qualityPresets, preferences.quality))
  preferences.quality = "original";
if (!["genre", "artist", "album"].includes(preferences.sortMode))
  preferences.sortMode = "genre";
preferences.arrayMode = normalizeMusicArrayMode(preferences.arrayMode);
preferences.rememberColumnPosition = preferences.rememberColumnPosition !== false;
preferences.developerMode = preferences.developerMode === true;
preferences.motionDebug = preferences.motionDebug === true;
preferences.motionSpeed = normalizeMusicMotionSpeed(preferences.motionSpeed);
setMusicMotionSpeed(preferences.motionSpeed);
preferences.songTransition = normalizeSongTransition(preferences.songTransition, preferences.songFade);
delete preferences.songFade;
const syncMotionScale = () => document.documentElement.style.setProperty("--music-motion-scale", String(1 / getMusicMotionSpeed()));
syncMotionScale();
onMusicMotionSpeedChange(syncMotionScale);
const sortLabels: Record<MusicSortMode, { name: string; column: string; code: string }> = {
  genre: { name: "按流派", column: "流派", code: "GENRE" },
  artist: { name: "按歌手名字", column: "歌手", code: "ARTIST" },
  album: { name: "按专辑名字", column: "分组", code: "ALBUMS" },
};
const sortLabel = sortLabels[preferences.sortMode];
let libraryReceived = false,
  scanSubmitting = false;
let scanRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let library: MusicLibrary = {
  version: 1,
  albums: [],
  genres: [],
  roots: [],
  scan: { running: false },
  onlineEnabled: false,
};
let albums: MusicAlbum[] = [],
  genres: MusicGenre[] = [],
  demo = false,
  selected = 0;
let mode: "archive" | "detail" = "archive",
  activeTab: "tracks" | "about" = "tracks",
  panel: Panel = null;
let scene: ArchiveScene | undefined,
  ready = false,
  apiAvailable = true,
  refreshing = false;
let introductionsStarting = false,
  libraryStateVersion = 0,
  introductionRequestError = "";

/**
 * Request outcome per album for the online supplement. Deliberately kept out of
 * the library snapshot: it is the state of a request, not library data, so it
 * must not survive a reload or be overwritten by a poll.
 *
 * A failed entry is kept here and never folded into the rendered archive, which
 * is what stops a failing request from re-triggering its own render.
 */
type OnlineEntry =
  | { state: "loading" }
  | { state: "done"; payload: AlbumArchiveOnline }
  | { state: "error"; error: string };
const onlineCache = new Map<string, OnlineEntry>();
let onlineBatch = false;
let viewer: ModelViewer | undefined;
let boot: MusicBoot | undefined;
const effects = new TerminalAudio();
effects.configure({
  sound: preferences.sound,
  music: false,
  soundVolume: preferences.soundVolume,
  musicVolume: 0,
});
document.addEventListener("pointerdown", () => void effects.unlock(), {
  once: true,
});
document.addEventListener("keydown", () => void effects.unlock(), {
  once: true,
});
let toastTimer: ReturnType<typeof setTimeout>,
  pollTimer: ReturnType<typeof setTimeout> | undefined;
let columnMemory = new Map<string, string>();
let playerState: MusicPlayerState;
const player = new MusicPlayer({
  volume: preferences.volume,
  songTransitionMode: preferences.songTransition,
  bgmEnabled: preferences.bgm,
  bgmVolume: preferences.bgmVolume,
});
{
  const native = getNativePlayback();
  const kernel = loadNativeKernelPrefs();
  native.log(`boot ${native.describe()} exclusive=${kernel.exclusive} device=${kernel.deviceId ?? "default"} backend=${player.state.backend}`);
  if (native.available) {
    native.setExclusive(kernel.exclusive);
    native.setDevice(kernel.deviceId);
    (globalThis as unknown as { __rhineNativeSfx?: (name: string) => void }).__rhineNativeSfx =
      (name: string) => {
        void native.sfx(name);
      };
    if (preferences.bgm) void native.bgm("enabled", undefined, true);
    void native.bgm("sfx-enabled", undefined, preferences.sound);
    void native.bgm("sfx-volume", preferences.soundVolume);
  }
}
const themeNames: Record<Theme, string> = {
  day: "暖昼",
  night: "深夜",
};
const stage = $("#stage");
stage.className = "music-app";
stage.dataset.mode = "archive";
stage.dataset.theme = preferences.theme;
stage.innerHTML = `
  <div id="three-scene" class="three-scene"></div>
  <div class="music-vignette" aria-hidden="true"></div>
  <header class="music-header">
    <div class="music-identity"><a class="music-brand" href="/" aria-label="Rhine Music 音乐库"><strong>RHINE LAB</strong><span>MUSIC ARCHIVE <i>／</i> 私人音乐终端</span></a></div>
    <nav class="music-topnav" aria-label="音乐终端导航">
      <button data-action="library" aria-label="音乐库">${icons.folder}<span>音乐库</span></button>
      <button data-action="search" aria-label="搜索">${icons.search}<span>搜索</span></button>
      <div class="theme-switch" aria-label="主题">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-label="${themeNames[t]}主题" aria-pressed="${preferences.theme === t}"><i class="theme-dot ${t}"></i><span>${themeNames[t]}</span></button>`).join("")}</div>
      <button data-action="settings" class="icon-button" aria-label="播放与画质设置">${icons.settings}</button>
      <div class="minimal-transport" role="group" aria-label="音乐播放">
        <div class="transport-stack">
          <span id="transport-track" class="transport-track" aria-hidden="true"><span id="transport-track-label"></span></span>
          <div class="transport-scrub" id="transport-scrub" hidden>
            <input type="range" id="transport-seek" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
            <span id="transport-time">0:00 / 0:00</span>
          </div>
        </div>
        <button data-action="play-pause" id="play-pause" aria-label="播放" aria-pressed="false"><span class="transport-glyph transport-play" aria-hidden="true">${icons.play}</span><span class="transport-glyph transport-pause" aria-hidden="true">${icons.pause}</span></button><button data-action="stop" id="stop-playback" aria-label="停止">${icons.stop}</button></div>
    </nav>
  </header>
  <div id="library-status" class="library-status"><i></i><span>正在读取本地音乐索引</span></div>
  <button type="button" class="music-view-toggle" disabled data-action="overview" aria-pressed="false" aria-label="切换缩略图模式">${svg('<rect x="3" y="3" width="6" height="7"/><rect x="15" y="3" width="6" height="7"/><rect x="3" y="14" width="6" height="7"/><rect x="15" y="14" width="6" height="7"/>')}<span>缩略图模式</span><kbd>V</kbd></button>
  <section class="music-overview" id="music-overview" aria-label="音乐库缩略图总览" hidden>
    <div class="overview-heading"><small>COLLECTION / OVERVIEW</small><h2>${sortLabel.name}浏览收藏</h2><p>点击列名展开入口 · 点击进入回到标准视图</p></div>
    <div class="overview-columns" id="overview-columns"></div>
    <button type="button" class="overview-return" data-action="overview-return" aria-label="返回标准视图">${svg('<path d="M15 5l-7 7 7 7"/>')}<span>返回近景</span><kbd>V</kbd></button>
    <nav class="overview-controls" aria-label="总览列导航"><button data-action="genre-prev" aria-label="总览上一列">←</button><span>← → 切换${sortLabel.column}</span><button data-action="genre-next" aria-label="总览下一列">→</button></nav>
  </section>
  <section id="music-browse" class="music-browse" aria-label="专辑浏览">
    <div class="music-browse-veil" aria-hidden="true"></div>
    <div class="album-callout"><p class="music-eyebrow">MUSIC ARCHIVE <span>／</span> <span id="selection-genre"></span></p>
      <div class="selection-rule"><span id="selection-code">ALBUM <span id="selection-code-number">001</span></span><span id="selection-format"></span></div>
      <h1 id="selection-title"></h1><p id="selection-artist" class="selection-artist"></p>
      <div class="selection-meta" id="selection-meta"></div>
      <button class="open-album" data-action="open">打开专辑 <span>↗</span></button>
    </div>
    <div class="music-navigation">
      <div class="music-counter"><span class="music-eyebrow">ALBUM / SELECT</span><div><b id="selection-number">01</b><span>/ <i id="selection-total">00</i></span></div></div>
      <div class="album-stepper"><button data-action="prev" aria-label="上一个专辑">↑</button><div id="album-ticks"></div><button data-action="next" aria-label="下一个专辑">↓</button></div>
      <div class="genre-stepper"><button data-action="genre-prev" aria-label="上一个${sortLabel.column}">←</button><div><small id="genre-position">${sortLabel.code} <span id="genre-index">01</span> / <span id="genre-total">00</span></small><button data-action="genres" id="genre-name"></button></div><button data-action="genre-next" aria-label="下一个${sortLabel.column}">→</button></div>
    </div>
    <div class="music-keyhint">← → ${sortLabel.column} <span>／</span> ↑ ↓ 专辑 <span>／</span> ENTER 打开专辑</div>
  </section>
  <section id="music-detail" class="music-detail" aria-label="专辑详情" hidden>
    <button class="music-back" data-action="back">← 返回专辑架 <kbd>ESC</kbd></button>
    <div class="card-caption"><span id="detail-card-id"></span><small>拖动卡片，查看完整封面</small></div>
    <div id="detail-surface" class="detail-surface"><article id="album-detail-content" tabindex="-1"></article></div>
  </section>
  <div id="music-empty" class="music-empty" hidden><small>YOUR PRIVATE COLLECTION</small><h1>让音乐进入这座档案馆。</h1><p>选择本地音乐文件夹，专辑封面会出现在每一张卡片上。</p><button data-action="library">设置音乐文件夹 ↗</button><button data-action="demo" class="subtle">先查看演示封面</button></div>
  <div class="music-bottomline"><span>LOCAL COLLECTION <i>·</i> <span id="library-count">0 ALBUMS</span></span><span id="runtime-info">THREE.JS / LOCAL / V${appVersion}</span></div>
  <div id="music-panel-root"></div><div id="music-toast" role="status" aria-live="polite"></div>
  <div id="music-loading"><span class="loading-orbit"></span><strong>OPENING THE ARCHIVE</strong><small>正在载入三维专辑架</small></div>
`;
const titleMotion = setupMusicTitleLayout(stage);
const textMotion = setupMusicTextMotion(stage);
// Keep the previous navigation available while the ruler version is on trial.
const tickMotion = new URLSearchParams(location.search).get("nav") === "previous"
  ? setupMusicTicks($("#album-ticks"))
  : setupMusicRuler($("#album-ticks"));
let selectionInitialized = false;
const selectionMotionEnabled = () =>
  ready &&
  !boot?.active &&
  mode === "archive" &&
  !$("#music-browse").hidden &&
  !preferences.reduced;
function syncSelectionMotion() {
  // Build static reels during the hidden camera movement, before the text fades in.
  const enabled = selectionMotionEnabled() ||
    (mode === "archive" && !!albums.length && !preferences.reduced);
  textMotion.setEnabled(enabled);
  if (!enabled) titleMotion.finish();
  else {
    const album = currentAlbum();
    if (album) titleMotion.update(album.title, true);
  }
}

function notify(message: string) {
  $("#music-toast").textContent = message;
  $("#music-toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => $("#music-toast").classList.remove("visible"),
    5500,
  );
}
function time(value: number) {
  const n = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function genreName(id: string) {
  return genres.find((g) => g.id === id)?.name || "未分类";
}
function currentAlbum() {
  return albums.find((a) => a.id === records[selected]?.id);
}
function formatList(a: MusicAlbum) {
  return (
    [
      ...new Set(
        a.tracks.map((t) => (t.codec ? `${t.format} / ${t.codec}` : t.format)),
      ),
    ].join(" · ") || (demo ? "封面演示" : "未提供")
  );
}
function albumDuration(a: MusicAlbum) {
  return a.tracks.reduce((sum, t) => sum + t.duration, 0);
}
function valueRange(
  values: (number | undefined)[],
  format: (n: number) => string,
) {
  const n = [
    ...new Set(values.filter((v): v is number => !!v && Number.isFinite(v))),
  ].sort((a, b) => a - b);
  return n.length
    ? n.length === 1
      ? format(n[0])
      : `${format(n[0])}–${format(n[n.length - 1])}`
    : "未提供";
}
function cover(a: MusicAlbum, className = "") {
  return a.coverUrl
    ? `<img class="${className}" src="${esc(a.coverUrl)}" alt="${esc(a.title)}专辑封面" loading="lazy">`
    : `<span class="cover-placeholder">♪</span>`;
}
const documentDecryption = new DocumentDecryption(
  "h1, .detail-artist, .album-facts span, .track-name strong, .album-about p, .archive-lead, .archive-block p, .archive-facts dd",
  0.35,
);
const tabTransition = new ContentTransition();
const detailTransition = new SurfaceTransition(
  $("#music-detail"),
  $("#album-detail-content"),
  360,
  240,
  "right",
);
const browseTransition = new SurfaceTransition(
  $("#music-browse"),
  undefined,
  // Keep the existing reveal timing, but fade each overlay in its own layer.
  // Fading the parent traps its text below the night vignette until opacity=1.
  720,
  140,
  "up",
  "cubic-bezier(0.45, 0, 0.25, 1)",
  [$(".music-browse-veil"), $(".album-callout"), $(".music-navigation"), $(".music-keyhint")],
);

/** Overview (thumbnail) mode: a pulled-back camera that labels the real columns. */
let overview = false;
let overviewRevealPending = false;
const overviewUI = new MusicOverviewUI($("#music-overview"), $("#overview-columns"), () => {
  const target = overview ? $(".overview-return") : $('[data-action="overview"]');
  target.focus({ preventScroll: true });
});
function setOverview(active: boolean, reveal = true) {
  if (active && (!ready || !albums.length || boot?.active || panel || mode !== "archive")) return;
  overview = active;
  overviewRevealPending = !active && reveal;
  scene?.setMusicOverview(active);
  stage.dataset.overview = String(active);
  const toggle = $<HTMLButtonElement>('[data-action="overview"]');
  toggle.setAttribute("aria-pressed", String(active));
  for (const item of stage.querySelectorAll<HTMLElement>(".music-topnav > :not(.minimal-transport)")) item.inert = active;
  toggle.inert = active || !!panel;
  overviewUI.setActive(active, preferences.reduced);
  $("#music-overview").inert = !active || !!panel;
  $("#music-browse").inert = active || !!panel;
  $("#music-browse").setAttribute("aria-hidden", String(active));
  if (active) {
    browseTransition.hide(preferences.reduced);
  }
}
function updateOverview() {
  if (!scene || (!overview && $("#music-overview").hidden)) return;
  overviewUI.update(scene.getOverviewColumns(), stage.clientWidth, stage.clientHeight,
    scene.musicOverviewProgress, preferences.reduced, sortLabel.column);
}
let motionControls: ReturnType<typeof setupMotionLab> | undefined;
let lightingControls: LightingLabController | undefined;

/**
 * Lyrics and the detail/lyrics switch.
 *
 * The pane is created empty on purpose: opening an album adds no lyric DOM, no
 * parse and no listener. The first `pointerdown` on the bar is what fetches,
 * parses and mounts a document, so browsing stays exactly as cheap as it was
 * before this feature existed.
 */
const lyricSettings = loadLyricsSettings();
const lyricsPane = new LyricsPane($("#music-detail"), {
  load: loadLyrics,
  current: () => lyricTarget(currentAlbum()),
  onError: () => notify("无法读取这首歌的歌词，可稍后重试。"),
});
const detailSwitch = new DetailSwitch({
  host: $("#music-detail"),
  surface: $("#detail-surface"),
  pane: lyricsPane,
  onWarmUp: () => void lyricsPane.prepare(),
  blocked: () => !!panel || !!boot?.active,
});
detailSwitch.setReduced(preferences.reduced);
lyricsPane.setReduced(preferences.reduced);
// Applied before the pane ever mounts a document, so the first lyric frame the
// user sees already carries their settings rather than the shipped defaults.
lyricsPane.setStyle(lyricSettings);

/** The track whose lyrics the pane shows: whatever plays, else the first. */
function lyricTarget(album: MusicAlbum | undefined): LyricsPaneTrack | undefined {
  if (!album?.tracks.length) return undefined;
  const playing = playerState?.currentTrack;
  const track = (playing && playing.albumId === album.id
    ? album.tracks.find((item) => item.id === playing.id)
    : undefined) ?? album.tracks[0];
  return track
    ? { trackId: track.id, title: track.title, artist: track.artist }
    : undefined;
}

async function loadLyrics(trackId: string): Promise<LyricsDocument> {
  if (!apiAvailable) return EMPTY_LYRICS;
  try {
    return parseLyricsPayload(
      await request<LyricsPayload>(`/api/lyrics/${encodeURIComponent(trackId)}`),
    );
  } catch {
    // No lyrics is a normal answer, not an error worth interrupting playback
    // for; the pane explains the sidecar convention instead.
    return EMPTY_LYRICS;
  }
}
let detailIdentity = "",
  pendingDetailFocus = false;

// ---------------------------------------------------------- 歌词预览（设置面板）

/** The tracks the preview can pick from: the album currently open in detail. */
function previewTracks(): LyricPreviewTrack[] {
  const album = currentAlbum();
  return album
    ? album.tracks.map((track) => ({ id: track.id, title: track.title, artist: track.artist }))
    : [];
}

/**
 * The preview's own lyric document, loaded lazily and cached per track. The
 * pane has its own loader and cache; this one is separate because the preview
 * deliberately shows a track the user *isn't* necessarily playing, without
 * disturbing what the pane is showing.
 */
const previewLyrics = new Map<string, LyricsDocument>();
let previewTrackId = "";
let previewLine = 0;
let previewFollow = false;
let previewClock = 0;

/** Resolves the lyric document for the currently selected preview track. */
async function previewDocument() {
  const id = previewTrackId;
  if (!id) return EMPTY_LYRICS;
  const cached = previewLyrics.get(id);
  if (cached) return cached;
  const document = await loadLyrics(id);
  previewLyrics.set(id, document);
  return document;
}

/** Renders the sample line for `line` of the selected track's document. */
async function renderPreviewLine(line: number) {
  const doc = await previewDocument();
  const lines = doc.lines;
  const index = Math.max(0, Math.min(line, Math.max(0, lines.length - 1)));
  const active = lines[index];
  if (!active) {
    setLyricPreviewSample("这首歌没有内嵌歌词。", 1);
    return;
  }
  // A frozen mid-line sweep: the pane would compute the real fraction from the
  // clock, but a still sample just needs a plausible, stable position.
  const p = doc.synced ? 0.46 : 1;
  setLyricPreviewSample(
    active.text,
    p,
    lines[index - 1]?.text ?? "",
    lines[index + 1]?.text ?? "",
  );
}

/** Refresh the preview against the current picker state. */
async function refreshPreviewSample() {
  const track = document.querySelector<HTMLSelectElement>("#lyric-preview-track");
  const lineSelect = document.querySelector<HTMLSelectElement>("#lyric-preview-line");
  previewTrackId = track?.value ?? "";
  previewLine = lineSelect ? Number(lineSelect.value) : 0;
  if (!previewTrackId) return;
  await renderPreviewLine(previewLine);
}

/** Called when the preview follow toggle flips; mirrors the playing track. */
async function syncPreviewFollow() {
  if (!previewFollow) return;
  const playing = playerState?.currentTrack;
  const album = currentAlbum();
  if (playing && album && playing.albumId === album.id) {
    const track = album.tracks.find((item) => item.id === playing.id);
    if (track) {
      const select = document.querySelector<HTMLSelectElement>("#lyric-preview-track");
      if (select && select.value !== track.id) {
        select.value = track.id;
        previewTrackId = track.id;
        previewLyrics.delete(track.id);
      }
      const doc = await previewDocument();
      const index = findActiveLine(doc, previewClock);
      const lineSelect = document.querySelector<HTMLSelectElement>("#lyric-preview-line");
      if (lineSelect && index >= 0) {
        setLyricPreviewLineCount(doc.lines.length);
        lineSelect.value = String(index);
      }
      if (index >= 0) await renderPreviewLine(index);
    }
  }
}

/** Wired once; the preview is only active while the panel is open. */
async function initPreviewControls() {
  const track = document.querySelector<HTMLSelectElement>("#lyric-preview-track");
  const lineSelect = document.querySelector<HTMLSelectElement>("#lyric-preview-line");
  const follow = document.querySelector<HTMLInputElement>("[data-lyric-preview='follow']");
  // The player already publishes a clock for the pane; the preview piggybacks
  // on it rather than running a second timer.
  if (track && lineSelect && follow) {
    // Reflect the toggle's last state; the markup rebuilds it unchecked.
    follow.checked = previewFollow;
    // Populate the line picker for the initial track once.
    previewTrackId = track.value;
    if (previewTrackId) {
      const doc = await previewDocument();
      setLyricPreviewLineCount(doc.lines.length);
      await renderPreviewLine(previewLine);
    }
  }
}

/** One place every lyric-settings change funnels through: pane, preview, save. */
function applyLyricSettings() {
  lyricsPane.setStyle(lyricSettings);
  syncLyricsUI(lyricSettings);
  const preview = document.getElementById("lyric-preview");
  if (preview) applyLyricTokens(preview, lyricSettings);
  saveLyricsSettings(lyricSettings);
}

/** Marks the most recently applied preset, if any, on the preset buttons. */
function markLyricPreset(id: string) {
  document
    .querySelectorAll<HTMLButtonElement>("[data-action='lyric-preset']")
    .forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.preset === id));
    });
}

async function exportLyricSettings() {
  const json = JSON.stringify(lyricSettings, null, 2);
  const status = document.querySelector("#lyric-transfer-status");
  try {
    await navigator.clipboard.writeText(json);
    if (status) status.textContent = "已复制到剪贴板。";
  } catch {
    const textarea = document.querySelector<HTMLTextAreaElement>("#lyric-json");
    if (textarea) textarea.value = json;
    if (status) status.textContent = "剪贴板不可用，已写入下方文本框，请手动复制。";
  }
}

function importLyricSettings() {
  const textarea = document.querySelector<HTMLTextAreaElement>("#lyric-json");
  const status = document.querySelector("#lyric-transfer-status");
  if (!textarea) return;
  try {
    // applyLyricPatch normalizes and clamps, so a hand-edited or partial JSON
    // can neither store an out-of-range value nor break the next render.
    Object.assign(lyricSettings, applyLyricPatch(lyricSettings, JSON.parse(textarea.value)));
    applyLyricSettings();
    if (status) status.textContent = "已应用。";
  } catch (error) {
    if (status) status.textContent = `JSON 无效：${(error as Error).message}`;
  }
}
const trackFocus = new MusicTrackFocus();
let pendingTrackReveal: { albumId: string; trackId: string } | undefined;
function cancelTrackReveal() {
  pendingTrackReveal = undefined;
  trackFocus.cancel();
}
/** Playback can reuse its open album; other targets take the archive route. */
function revealAlbum(
  albumId: string,
  trackId?: string,
  options: { reuseOpenAlbum?: boolean } = {},
) {
  closePanel(() => {
    cancelTrackReveal();
    if (!ready || boot?.active) return;
    const index = records.findIndex((record) => record.id === albumId);
    const album = albums.find((item) => item.id === albumId);
    if (index < 0 || !album || (trackId && !album.tracks.some((track) => track.id === trackId))) {
      notify("这张专辑或歌曲已不在当前音乐库中，请刷新音乐库后重试。");
      return;
    }
    const targetTrack = trackId;
    if (options.reuseOpenAlbum && targetTrack && !libraryRebuilding &&
      currentAlbum()?.id === albumId && presentation.openingOrDetail &&
      !presentation.pendingSelection &&
      ["detail", "opening", "switching"].includes(presentation.phase)) {
      setTab("tracks");
      pendingTrackReveal = { albumId, trackId: targetTrack };
      return;
    }
    if (targetTrack) pendingTrackReveal = { albumId, trackId: targetTrack };
    select(index, undefined, true, "archive");
  });
}
// The pane is interactive while its entrance is finishing. Cancel a queued
// reveal too, so a click/scroll in that interval is never pulled back later.
for (const event of ["wheel", "pointerdown", "touchstart", "keydown"] as const) {
  $("#album-detail-content").addEventListener(event, () => {
    if (pendingTrackReveal) cancelTrackReveal();
  }, { passive: true });
}
let libraryRebuilding = false;
type LibraryIntent = AlbumSelection & { openAfter: boolean } |
  { mode: "archive" | "detail" };
let libraryIntent: LibraryIntent | undefined;
const presentation = new MusicPresentation({
  presentationReady: () => scene?.musicPresentationReady ?? false,
  archiveReady: () => scene?.musicArchiveReady ?? false,
  archiveInteractive: () => scene?.musicArchiveInteractive ?? false,
  enterCamera: () => {
    scene?.setMode("detail");
    effects.setScene("detail");
    effects.play("open");
  },
  returnCamera: () => {
    scene?.setMode("archive");
    effects.setScene("archive");
    effects.play("back");
  },
  select: ({ index, navigation }) => commitSelection(index, navigation),
  switchDetail: ({ index, navigation }) => commitSelection(index, navigation, true),
  mode: (next) => {
    mode = next;
    stage.dataset.mode = next;
    // Returning to the shelf closes the lyrics surface without animating, so
    // the next album opens on its own details rather than someone else's words.
    if (next === "archive") detailSwitch.reset();
    syncSelectionMotion();
  },
  prepareMenu: () => {
    activeTab = "tracks";
    detailTransition.hide(true);
    renderDetail();
    const content = $("#album-detail-content");
    content.style.removeProperty("opacity");
    content.style.removeProperty("transform");
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
  },
  showMenu: () => {
    const detail = $("#music-detail"), content = $("#album-detail-content");
    detailTransition.show(preferences.reduced);
    // The page is measurable from here on; the bar's dock depends on its height.
    detailSwitch.syncAlbum();
    detail.inert = !!panel;
    detail.setAttribute("aria-hidden", "false");
    content.inert = false;
    content.scrollTop = 0;
    documentDecryption.reset(content, preferences.reduced);
    pendingDetailFocus = true;
  },
  hideMenu: (done) => {
    trackFocus.cancel();
    pendingDetailFocus = false;
    tabTransition.cancel();
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
    detailTransition.hide(preferences.reduced, done);
  },
  hideBrowse: (done) => {
    $("#music-browse").inert = true;
    $("#music-browse").setAttribute("aria-hidden", "true");
    browseTransition.hide(preferences.reduced, done);
  },
  showBrowse: showBrowseSurface,
});
boot = new MusicBoot(stage, {
  reduced: () => preferences.reduced,
  onStart: () => {
    cancelTrackReveal();
    presentation.reset();
    detailTransition.hide(true);
    browseTransition.hide(true);
    scene?.setMode("hidden");
    syncSelectionMotion();
  },
  onComplete: (reason) => {
    const now = performance.now() / 1000;
    if (reason === "skip") scene?.showMusicArchiveImmediately(now);
    else scene?.finishMusicIntro(now);
    effects.setScene("archive");
    showBrowseSurface();
  },
});
function showBrowseSurface() {
  syncAlbumNavigation();
  if (!albums.length || boot?.active) return;
  if (overview) { $("#music-browse").inert = true; return; }
  browseTransition.show(preferences.reduced);
  $("#music-browse").inert = !!panel;
  $("#music-browse").setAttribute("aria-hidden", "false");
  syncSelectionMotion();
  if (!panel) $("[data-action=open]").focus({ preventScroll: true });
}
function savePrefs() {
  save("rhine-music-preferences", preferences);
}
function setTheme(theme: Theme) {
  if (theme !== "day" && theme !== "night") theme = "day";
  if (theme === preferences.theme) return;
  preferences.theme = theme;
  stage.dataset.theme = theme;
  scene?.setTheme(theme, !preferences.reduced);
  viewer?.setTheme(theme);
  document
    .querySelectorAll<HTMLButtonElement>("button[data-theme]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.theme === theme)),
    );
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "night" ? "#0a1220" : "#e8e5e1");
  savePrefs();
}
function fit() {
  // Use the same stage dimensions and aspect boundary as the scene framing.
  stage.dataset.layout = viewportLayout(stage.clientWidth, stage.clientHeight, false).kind;
  scene?.resize();
  viewer?.resize();
  if (mode === "detail") {
    syncTabIndicator(false);
    documentDecryption.refresh();
    // The bar's travel is measured from the detail page's own height.
    detailSwitch.syncAlbum();
  }
}
window.addEventListener("resize", fit);

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data)
    throw new Error(data?.error || `本地服务请求失败 (${response.status})`);
  return data as T;
}
async function loadLibrary(force = false) {
  // Keep the selected cards and cover atlas stable for the opening shot.
  if (boot?.active) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(force), 1000);
    return;
  }
  if (refreshing) return;
  refreshing = true;
  const stateVersion = libraryStateVersion;
  try {
    const next = await request<MusicLibrary>("/api/library");
    apiAvailable = true;
    if (stateVersion === libraryStateVersion && !boot?.active) await receiveLibrary(next, force);
  } catch (error) {
    apiAvailable = false;
    updateStatus();
    updateIntroductionStatus();
    if (force)
      notify(
        `${(error as Error).message}。请使用 npm run music 启动本地音乐服务。`,
      );
  } finally {
    refreshing = false;
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(
    () => void loadLibrary(),
    library.scan.running ||
      library.enrich?.running ||
      library.introductions?.running
      ? 1400
      : 12000,
  );
}
async function receiveLibrary(next: MusicLibrary, force = false) {
  const previousScan = library.scan;
  const scanCompleted = libraryReceived && !next.scan.running && !next.scan.error &&
    !!next.scan.finishedAt && next.scan.finishedAt !== previousScan.finishedAt;
  const scanFailed = libraryReceived && previousScan.running && !next.scan.running && !!next.scan.error;
  libraryReceived = true;
  const previousIntroductionRun = library.introductions;
  const changed =
    JSON.stringify(next.albums) !== JSON.stringify(library.albums) ||
    JSON.stringify(next.genres) !== JSON.stringify(library.genres);
  library = next;
  if (library.introductions?.running) introductionRequestError = "";
  if (changed || force) await applyLibrary();
  updateStatus();
  if (panel === "library") updateScanStatus();
  updateIntroductionStatus();
  if (
    previousIntroductionRun?.running &&
    library.introductions &&
    !library.introductions.running
  ) {
    const result = library.introductions;
    notify(
      result.error ||
        `专辑介绍查询完成：更新 ${result.updated} 张，未找到可靠资料 ${result.notFound} 张，查询失败 ${result.failed} 张。`,
    );
  }
  if (scanFailed) notify(`音乐库扫描失败：${next.scan.error}`);
  if (scanCompleted && !scanRefreshTimer) {
    notify("音乐库扫描完成，2 秒后自动刷新页面。");
    scanRefreshTimer = setTimeout(() => location.reload(), 2000);
  }
}
async function applyLibrary() {
  const hadAlbums = albums.length > 0;
  const previousId = currentAlbum()?.id;
  const previousDetail = JSON.stringify(currentAlbum());
  const visualKey = (items: MusicAlbum[], groups: MusicGenre[]) =>
    JSON.stringify([
      items.map((a) => [a.id, a.title, a.artist, a.genreId, a.coverUrl]),
      groups.map((g) => [g.id, g.name]),
    ]);
  const oldVisual = visualKey(albums, genres);
  if (library.albums.length) demo = false;
  albums = orderMusicAlbums(demo ? demoAlbums : library.albums, preferences.sortMode);
  genres = demo ? demoGenres : library.genres;
  setMusicAlbums(albums, genres, preferences.sortMode);
  selected = Math.max(
    0,
    records.findIndex((r) => r.id === previousId),
  );
  columnMemory = new Map(
    archiveColumns.map((name, lane) => [
      name,
      records[columnFiles(lane)[0]]?.id,
    ]),
  );
  if (scene && ready && oldVisual !== visualKey(albums, genres)) {
    const reopen = presentation.openingOrDetail;
    cancelTrackReveal();
    libraryRebuilding = true;
    libraryIntent = undefined;
    presentation.reset();
    detailTransition.hide(true);
    browseTransition.hide(true);
    try { await scene.refreshLibrary(selected); }
    finally { libraryRebuilding = false; }
    const intent = libraryIntent as LibraryIntent | undefined;
    libraryIntent = undefined;
    scene.setMode("archive");
    if (intent && "index" in intent)
      select(intent.index, intent.navigation, intent.openAfter, intent.route);
    else if ((intent ? intent.mode === "detail" : reopen) && albums.length)
      presentation.open();
    else showBrowseSurface();
  }
  if (!albums.length) {
    cancelTrackReveal();
    presentation.reset();
  }
  stage.dataset.mode = mode;
  $("#music-empty").hidden = albums.length > 0;
  // Ordinary index refreshes must not reveal a page while its peer is exiting.
  if (!ready || !hadAlbums || !albums.length) {
    if (albums.length && mode === "archive") browseTransition.show(true);
    else browseTransition.hide(true);
    // Detail is revealed exclusively by the camera completion gate.
    if (presentation.phase !== "detail") detailTransition.hide(true);
    $("#music-browse").inert = !albums.length || mode !== "archive" || !!panel;
    $("#music-detail").inert = !albums.length || mode !== "detail" || !!panel;
    $("#music-browse").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "archive"),
    );
    $("#music-detail").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "detail"),
    );
  }
  updateSelection();
  if (mode === "detail" && previousDetail !== JSON.stringify(currentAlbum()))
    renderDetail();
  updateStatus();
}
function updateStatus() {
  const n = library.albums.length,
    tracks = library.albums.reduce((sum, a) => sum + a.tracks.length, 0);
  const label = !apiAvailable
    ? "本地音乐服务尚未连接"
    : library.scan.running
      ? "正在扫描音乐库…"
      : library.enrich?.running
        ? `补充在线资料 ${library.enrich.completed}/${library.enrich.total}`
        : library.introductions?.running
          ? `查询专辑介绍 ${library.introductions.completed}/${library.introductions.total}`
          : demo
            ? "演示专辑 · 加入音乐后显示真实封面"
            : "";
  $("#library-status span").textContent = label;
  $("#library-status").hidden = !label;
  $("#library-status").classList.toggle(
    "working",
    !!library.scan.running ||
      !!library.enrich?.running ||
      !!library.introductions?.running,
  );
  $("#library-count").textContent = demo
    ? "DEMONSTRATION"
    : `${n} ALBUMS / ${tracks} TRACKS`;
  const overviewToggle = document.querySelector<HTMLButtonElement>('[data-action="overview"]');
  if (overviewToggle) {
    overviewToggle.hidden = !n;
    overviewToggle.disabled = !ready || !n;
  }
}
function updateSelection(navigation?: ArchiveNavigation) {
  const a = currentAlbum();
  if (!a) {
    selectionInitialized = false;
    textMotion.finish();
    titleMotion.finish();
    return;
  }
  const location = fileLocation(selected),
    files = columnFiles(location.lane),
    idx = files.indexOf(selected);
  const animated = selectionInitialized && selectionMotionEnabled();
  selectionInitialized = true;
  textMotion.update(
    {
      number: idx + 1,
      total: files.length,
      genresTotal: archiveColumns.length,
      code: selected + 1,
      genreIndex: location.lane + 1,
      genre: archiveColumns[location.lane],
      genreName: archiveColumns[location.lane],
      format: demo
        ? "DEMO"
        : [...new Set(a.tracks.map((t) => t.format))].join(" / "),
      artist: a.artist,
      meta: [
        a.year ? String(a.year) : "年份未提供",
        demo ? "演示封面" : `${a.tracks.length} 首曲目`,
        a.tracks.length ? time(albumDuration(a)) : "",
      ]
        .filter(Boolean)
        .join("  /  "),
    },
    animated,
    navigation,
  );
  titleMotion.update(a.title, animated);
  $("#selection-title").title = a.title;
  tickMotion.update(
    files.map((index) => ({ index, id: records[index].id, title: records[index].title })),
    selected,
    preferences.reduced,
    navigation,
  );
  $("#detail-card-id").textContent =
    `ALBUM / ${String(selected + 1).padStart(3, "0")}`;
  // Hidden archive content can prepare its static reels before the reveal.
  if (!animated) syncSelectionMotion();
}
function commitSelection(index: number, navigation?: ArchiveNavigation, keepDetail = false) {
  selected = wrap(index, records.length);
  if (preferences.rememberColumnPosition) columnMemory.set(
    archiveColumns[fileLocation(selected).lane],
    records[selected].id,
  );
  if (keepDetail) scene?.switchMusicAlbum(selected, navigation);
  else scene?.select(selected, navigation);
  updateSelection(navigation);
  effects.play(
    navigation && "axis" in navigation && navigation.axis === "lane"
      ? "column"
      : "tick",
  );
}
function select(index: number, navigation?: ArchiveNavigation, openAfter = presentation.openingOrDetail, route?: AlbumSelection["route"]) {
  if (!records.length || !ready || boot?.active || index < 0) return;
  if (route !== "archive") cancelTrackReveal();
  const pending = libraryRebuilding && libraryIntent && "index" in libraryIntent
    ? libraryIntent : presentation.pendingSelection;
  const previous = pending?.navigation;
  if (pending) {
    // Coalesced key presses still reach the matching physical loop cell.
    navigation = previous && navigation && "axis" in previous && "axis" in navigation && previous.axis === navigation.axis
      ? { axis: navigation.axis, direction: previous.direction + navigation.direction }
      : undefined;
  }
  if (libraryRebuilding) {
    libraryIntent = { index: wrap(index, records.length), navigation, openAfter, route };
    return;
  }
  presentation.select({ index: wrap(index, records.length), navigation, route }, openAfter);
}
function navigationSelection() {
  if (libraryRebuilding && libraryIntent && "index" in libraryIntent) return libraryIntent.index;
  return presentation.pendingSelection?.index ?? selected;
}
/** Pending detail/return requests already define the next input boundary. */
function syncAlbumNavigation() {
  const cursor = navigationSelection();
  const files = records.length ? columnFiles(fileLocation(cursor).lane) : [];
  const ordinal = files.indexOf(cursor);
  const bounded = preferences.arrayMode === "realistic";
  for (const button of stage.querySelectorAll<HTMLButtonElement>('[data-action="prev"], [data-action="next"]')) {
    button.disabled = !files.length || (bounded && (button.dataset.action === "prev"
      ? ordinal <= 0 : ordinal >= files.length - 1));
  }
}
function stepAlbum(direction: number) {
  if (!records.length) return;
  const cursor = navigationSelection();
  const files = columnFiles(fileLocation(cursor).lane);
  if (files.length < 2) return;
  const ordinal = files.indexOf(cursor);
  const target = preferences.arrayMode === "realistic"
    ? Math.max(0, Math.min(files.length - 1, ordinal + direction))
    : wrap(ordinal + direction, files.length);
  const delta = preferences.arrayMode === "realistic" ? target - ordinal : direction;
  // A boundary input must not restart a detail handoff or cancel track focus.
  if (!delta) return;
  select(files[target], { axis: "row", direction: delta });
}
/** Column arrows and overview entry obey one browsing-position preference. */
function resolveColumnSelection(lane: number): { index: number; row?: number } {
  const files = columnFiles(lane);
  if (!files.length) return { index: -1 };
  if (preferences.rememberColumnPosition) {
    const remembered = columnMemory.get(archiveColumns[lane]);
    const index = files.find((index) => records[index]?.id === remembered);
    return { index: index ?? files[0] };
  }
  // The rendered rail can still be between targets after rapid input. Sample
  // its actual depth, then preserve that physical occurrence in filled arrays.
  const depth = Math.round(scene?.musicBrowseRowForColumn(lane) ??
    scene?.musicBrowseRow ?? fileLocation(navigationSelection()).row);
  const row = preferences.arrayMode === "realistic"
    ? Math.max(12, Math.min(11 + files.length, depth)) : depth;
  return { index: fileAtCell({ lane, row }), row };
}
function stepGenre(direction: number) {
  overviewUI.collapse();
  if (!records.length || archiveColumns.length < 2) return;
  const lane = wrap(
    fileLocation(navigationSelection()).lane + direction,
    archiveColumns.length,
  );
  const target = resolveColumnSelection(lane);
  select(target.index, {
    axis: "lane",
    direction,
    row: target.row,
  });
}
function setMode(next: "archive" | "detail") {
  if (boot?.active) return;
  if (next === "archive") cancelTrackReveal();
  if (libraryRebuilding) { libraryIntent = { mode: next }; return; }
  if (next === "detail") {
    if (currentAlbum()) presentation.open();
  } else presentation.back();
}
function syncTabIndicator(animate = true) {
  const button = document.querySelector<HTMLElement>(`#tab-${activeTab}`);
  const indicator = document.querySelector<HTMLElement>(".music-tab-indicator");
  if (!button || !indicator) return;
  indicator.style.transition = animate && !preferences.reduced ? "" : "none";
  indicator.style.transform = `translateX(${button.offsetLeft}px) scaleX(${button.offsetWidth})`;
}
/**
 * The detail column's persistent element handles.
 *
 * Rewriting the whole article with `innerHTML` destroyed and rebuilt the tab
 * rail on every album step. That rail carries `backdrop-filter: blur(18px)`, so
 * replacing it discards the blurred layer and makes the compositor build a new
 * one, and the same write re-parsed the archive panel and all eight fact rows
 * for content that had not changed. Stepping through albums is the most
 * repeated gesture in the library, so the skeleton is built once and only the
 * regions that actually differ are rewritten.
 *
 * `h1` stays a direct child of the article: four stylesheet rules select it as
 * `#album-detail-content > h1`, so the upper region cannot be wrapped.
 */
interface DetailParts {
  index: HTMLElement;
  title: HTMLElement;
  artist: HTMLElement;
  facts: HTMLElement;
  archive: HTMLElement;
  tabs: HTMLElement;
  tabContent: HTMLElement;
}

let detailParts: DetailParts | undefined;

function detailSkeleton(article: HTMLElement): DetailParts {
  const live = detailParts;
  // A detached rail means something replaced the article wholesale (a layout
  // rebuild, a fresh boot), so the handles cannot be trusted any more.
  if (live && live.tabs.isConnected) return live;
  article.innerHTML = `<div class="detail-overline"><span data-part="index"></span><div class="detail-album-navigation" role="group" aria-label="切换专辑"><button data-action="prev" aria-label="上一张专辑">↑ 上一张</button><button data-action="next" aria-label="下一张专辑">下一张 ↓</button></div></div><h1></h1><p class="detail-artist"></p><div class="album-facts"></div><div class="archive-mount"></div><div class="music-tabs" role="tablist" aria-label="专辑信息"><button role="tab" id="tab-tracks" data-tab="tracks" aria-controls="album-tab-content"><span>01</span> 歌单</button><button role="tab" id="tab-about" data-tab="about" aria-controls="album-tab-content"><span>02</span> 专辑介绍</button><i class="music-tab-indicator" aria-hidden="true"></i></div><div id="album-tab-content" role="tabpanel"></div>`;
  detailParts = {
    index: article.querySelector<HTMLElement>('[data-part="index"]')!,
    title: article.querySelector<HTMLElement>("h1")!,
    artist: article.querySelector<HTMLElement>(".detail-artist")!,
    facts: article.querySelector<HTMLElement>(".album-facts")!,
    archive: article.querySelector<HTMLElement>(".archive-mount")!,
    tabs: article.querySelector<HTMLElement>(".music-tabs")!,
    tabContent: article.querySelector<HTMLElement>("#album-tab-content")!,
  };
  return detailParts;
}

/**
 * Writes the rail's selected state.
 *
 * Only the state, never the markup: both tab labels are constant, so the rail
 * never needs re-parsing. `data-tab` records what has been written, which lets
 * `renderDetail` skip the indicator read that would force a second layout.
 */
function syncTabState(tabs: HTMLElement, animate = false) {
  tabs.dataset.tab = activeTab;
  tabs.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === activeTab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  syncTabIndicator(animate);
}
function setTab(tab: "tracks" | "about") {
  if (activeTab === tab) return;
  cancelTrackReveal();
  activeTab = tab;
  const rail = document.querySelector<HTMLElement>(".music-tabs");
  if (rail) syncTabState(rail, true);
  const a = currentAlbum();
  if (!a) return;
  const content = $("#album-tab-content");
  content.innerHTML =
    tab === "tracks" ? trackList(a, a.discCount || 1) : albumAbout(a);
  content.setAttribute("aria-labelledby", `tab-${tab}`);
  documentDecryption.refresh();
  tabTransition.reveal(content, preferences.reduced);
  updatePlayingRows();
  effects.play("ui-tick");
}
function renderDetail() {
  const a = currentAlbum();
  if (!a) return;
  trackFocus.cancel();
  const discs =
    a.discCount || Math.max(1, ...a.tracks.map((t) => t.discNumber || 1));
  const bits =
    a.tracks.length && a.tracks.every((t) => t.lossless === false)
      ? "有损编码"
      : valueRange(
          a.tracks.map((t) => t.bitsPerSample),
          (n) => `${n} bit`,
        );
  const rate = valueRange(
    a.tracks.map((t) => t.sampleRate),
    (n) => `${Number((n / 1000).toFixed(1))} kHz`,
  );
  const bitrate = valueRange(
    a.tracks.map((t) => t.bitrate),
    (n) => `${Math.round(n / 1000)} kbps`,
  );
  const fields = [
    ["RELEASE / 发行年份", a.year || "未提供"],
    ["ARTIST / 歌手", a.artist],
    ["GENRE / 流派", genreName(a.genreId)],
    ["VOLUMES / 内含 CD", demo ? "—" : `${discs} CD · ${a.tracks.length} 首`],
    ["FORMAT / 文件格式", formatList(a)],
    ["RESOLUTION / 位深与采样率", `${bits} / ${rate}`],
    ["BITRATE / 码率", bitrate],
    ["DURATION / 总时长", time(albumDuration(a))],
  ];
  const article = $("#album-detail-content"),
    sameAlbum = detailIdentity === a.id,
    scroll = sameAlbum ? article.scrollTop : 0;
  detailIdentity = a.id;
  const parts = detailSkeleton(article);
  parts.index.textContent = `ALBUM ${String(selected + 1).padStart(3, "0")}`;
  parts.title.title = a.title;
  parts.title.innerHTML = albumTitleMarkup(a.title);
  parts.artist.innerHTML = `${esc(a.artist)}${a.offline ? '<span class="offline-badge">目录离线</span>' : ""}`;
  parts.facts.innerHTML = fields
    .map(([name, value]) => `<div><small>${name}</small><span>${esc(String(value))}</span></div>`)
    .join("");
  parts.archive.innerHTML = albumArchiveMarkup(
    resolveAlbumArchive(a, archiveContextFor(a)),
    esc,
    archiveActionsFor(a),
  );
  // The rail's geometry moves only when the selected tab does, so the indicator
  // read (`offsetLeft`/`offsetWidth`, a forced layout) is skipped otherwise.
  if (parts.tabs.dataset.tab !== activeTab) syncTabState(parts.tabs);
  parts.tabContent.innerHTML =
    activeTab === "tracks" ? trackList(a, discs) : albumAbout(a);
  parts.tabContent.setAttribute("aria-labelledby", `tab-${activeTab}`);
  article.scrollTop = scroll;
  documentDecryption.reset(
    article,
    preferences.reduced || scene?.decryptionFrame.phase === "clear",
  );
  updatePlayingRows();
  // The pane belongs to one album; stepping albums releases its document
  // rather than leaving another album's lyrics mounted behind the detail.
  lyricsPane.setTrack(lyricTarget(a));
  detailSwitch.syncAlbum();
}
/** Shelf position of an album, used by the archive panel's derived facts. */
function archiveContextFor(a: MusicAlbum): AlbumArchiveContext {
  const online = onlineCache.get(a.id);
  const onlinePayload = online?.state === "done" ? online.payload : undefined;
  const ordinal = records.findIndex((record) => record.id === a.id);
  if (ordinal < 0) return { online: onlinePayload };
  const location = fileLocation(ordinal);
  return {
    ordinal: ordinal + 1,
    libraryCount: records.length,
    column: archiveColumns[location.lane],
    columnIndex: location.lane + 1,
    columnCount: archiveColumns.length,
    online: onlinePayload,
  };
}
/** Control state for the archive panel's online button. */
function archiveActionsFor(a: MusicAlbum) {
  const entry = onlineCache.get(a.id);
  return {
    albumId: a.id,
    busy: entry?.state === "loading",
    adopted: entry?.state === "done" && entry.payload.status === "ok",
    notice: onlineNotice(a.id),
  };
}
/**
 * What the panel says about this album's supplement. It always distinguishes
 * "not asked yet", "asked and nothing was adopted" and "could not be reached",
 * because the three need different follow-up from the reader.
 */
function onlineNotice(id: string) {
  const entry = onlineCache.get(id);
  if (!entry) return "";
  if (entry.state === "loading") return "正在读取线上资料…";
  if (entry.state === "error") return `线上补录失败：${entry.error}`;
  const payload = entry.payload;
  if (payload.status === "disabled")
    return payload.reason || "线上补录已在资料库设置中关闭。";
  if (payload.status === "ok") {
    const unanswered = (payload.providers ?? []).filter(
      (provider) => provider.status !== "ok",
    );
    const when = payload.checkedAt
      ? new Date(payload.checkedAt).toLocaleString("zh-CN")
      : "";
    return `已读取线上资料${payload.cached ? "（本机缓存）" : ""}${when ? ` · 核对于 ${when}` : ""}。${
      unanswered.length
        ? `未采用的来源：${unanswered
            .map((provider) => `${provider.label}（${provider.detail || provider.status}）`)
            .join("；")}。`
        : ""
    }`;
  }
  return payload.error || payload.reason || "公开来源未找到可靠对应的条目。";
}
/** `consent=1` marks a deliberate click; `force=1` asks the server to skip its cache. */
function onlineQuery(id: string, force: boolean) {
  const params = new URLSearchParams({ consent: "1" });
  if (force) params.set("force", "1");
  return `/api/album-online/${encodeURIComponent(id)}?${params}`;
}
/**
 * Re-renders just the archive panel. A whole `renderDetail()` would replay the
 * reading column's reveal animation on every finished request, which is exactly
 * the flicker this panel is meant to avoid.
 */
function patchArchive() {
  const a = currentAlbum();
  const section = document.querySelector("#album-detail-content .album-archive");
  if (!a || !section) return;
  section.outerHTML = albumArchiveMarkup(
    resolveAlbumArchive(a, archiveContextFor(a)),
    esc,
    archiveActionsFor(a),
  );
  // The replaced subtree needs the same reading treatment as the original.
  documentDecryption.refresh();
}
/** Updates the control in place for the states that change before content does. */
function syncOnlineControls(id: string) {
  const entry = onlineCache.get(id);
  const busy = entry?.state === "loading";
  const button = document.querySelector<HTMLButtonElement>(
    '#album-detail-content [data-action="online-album"]',
  );
  if (button) {
    button.disabled = busy;
    button.textContent = busy
      ? "正在读取线上资料…"
      : entry?.state === "done" && entry.payload.status === "ok"
        ? "重新读取线上资料 ↗"
        : "线上补充详情与背景 ↗";
  }
  const note = document.querySelector<HTMLElement>(
    `[data-online-feedback="${id}"]`,
  );
  if (note) note.textContent = onlineNotice(id);
}
async function loadOnline() {
  const album = currentAlbum();
  if (demo || !album || album.offline) return;
  const existing = onlineCache.get(album.id);
  if (existing?.state === "loading") return;
  // A second click on an album that already has a supplement is a refresh, so
  // it asks the server to look again rather than replay its own cache.
  const force = existing?.state === "done";
  onlineCache.set(album.id, { state: "loading" });
  syncOnlineControls(album.id);
  try {
    const payload = await request<AlbumArchiveOnline>(onlineQuery(album.id, force));
    onlineCache.set(album.id, { state: "done", payload });
    if (currentAlbum()?.id === album.id) patchArchive();
  } catch (error) {
    onlineCache.set(album.id, { state: "error", error: (error as Error).message });
    if (currentAlbum()?.id === album.id) syncOnlineControls(album.id);
  }
}
/** Reads the supplement for every album that has not been asked yet. */
async function loadOnlineLibrary() {
  if (demo || !library.albums.length || onlineBatch) return;
  const targets = library.albums.filter(
    (album) => !album.offline && onlineCache.get(album.id)?.state !== "done",
  );
  if (!targets.length) {
    notify("每一张专辑的线上资料都已读取过。");
    return;
  }
  onlineBatch = true;
  let adopted = 0;
  let missed = 0;
  const report = (index: number) =>
    updateOnlineBatchStatus(
      `正在读取线上资料 ${index} / ${targets.length}…（已采用 ${adopted} 张，未采用 ${missed} 张）`,
    );
  report(0);
  try {
    for (let index = 0; index < targets.length; index++) {
      const album = targets[index];
      try {
        const payload = await request<AlbumArchiveOnline>(
          onlineQuery(album.id, false),
        );
        onlineCache.set(album.id, { state: "done", payload });
        if (payload.status === "ok") adopted++;
        else missed++;
      } catch (error) {
        onlineCache.set(album.id, { state: "error", error: (error as Error).message });
        missed++;
      }
      report(index + 1);
      // Keep the open album's panel in step while the run walks past it.
      if (currentAlbum()?.id === album.id) patchArchive();
    }
  } finally {
    onlineBatch = false;
    updateOnlineBatchStatus("");
    notify(`线上资料读取完成：采用 ${adopted} 张，未采用或失败 ${missed} 张。`);
  }
}
function updateOnlineBatchStatus(text: string) {
  const el = document.querySelector("#online-status");
  if (el) el.textContent = text;
}
function trackList(a: MusicAlbum, discs: number) {
  if (!a.tracks.length)
    return `<div class="empty-tracks"><strong>${demo ? "这是一张封面演示卡片" : "这个专辑还没有可播放曲目"}</strong><p>${demo ? "用于检查封面原始比例与卡片材质。扫描本地音乐库后，这里会显示真实曲目。" : "请检查音乐文件是否完整，并重新扫描音乐库。"}</p><button data-action="library">打开音乐库设置 ↗</button></div>`;
  let disc = -1;
  return `<div class="track-list" aria-label="专辑歌曲列表">${a.tracks
    .map((t, index) => {
      const discNo = t.discNumber || 1;
      const head =
        discs > 1 && discNo !== disc
          ? `<div class="disc-heading">DISC ${String(discNo).padStart(2, "0")}</div>`
          : "";
      disc = discNo;
      return `${head}<button class="track-row" data-track="${esc(t.id)}" ${a.offline ? "disabled" : ""} aria-label="播放 ${esc(t.title)}"><span class="track-number">${String(t.trackNumber || index + 1).padStart(2, "0")}</span><span class="track-name"><strong>${esc(t.title)}</strong><small>${esc(t.artist)}</small></span><span class="track-format">${esc(t.format)}${!t.browserPlayable ? '<i title="需要兼容的播放内核"> ↗</i>' : ""}</span><span class="track-duration">${time(t.duration)}</span></button>`;
    })
    .join("")}</div>${producerBlock(a)}`;
}
function albumAbout(a: MusicAlbum) {
  return `<section class="album-about"><small>ABOUT THIS ALBUM</small>
    ${a.description ? `<p>${esc(a.description)}</p>${a.descriptionSource ? `<a class="text-button" href="${esc(a.descriptionSource.url)}" target="_blank" rel="noopener">来源：${esc(a.descriptionSource.name)} ↗</a>${a.descriptionSource.license ? `<small class="introduction-license">${esc(a.descriptionSource.license)}</small>` : ""}` : ""}` : `<h3>专辑介绍待补充</h3><p>从公开百科核对专辑与歌手后读取介绍，附上来源并保存在本机。无法确认对应专辑时保留空白。</p>`}
    ${!demo ? `<button data-action="introduction-album" class="text-button" ${introductionsStarting || library.introductions?.running ? "disabled" : ""}>${a.description ? "更新" : "查询"}专辑介绍 ↗</button><p class="introduction-feedback" data-introduction-feedback="${esc(a.id)}" role="status">${esc(introductionAlbumStatus(a))}</p>` : ""}
    <div class="source-note"><span>本地目录</span><code>${esc(a.folder)}</code></div><div class="genre-tags">${a.rawGenres.map((g) => `<span>${esc(g)}</span>`).join("")}</div></section>${producerBlock(a)}`;
}
function introductionAlbumStatus(a: MusicAlbum) {
  const lookup = a.introduction;
  if (lookup?.status === "error")
    return `介绍查询失败：${lookup.error || "资料来源暂时无法访问，请稍后重试。"}${a.description ? " 已有介绍仍然保留。" : ""}`;
  if (lookup?.status === "uncertain")
    return `找到可能的同名专辑，尚无法可靠确认，暂未采用介绍。${a.description ? " 已保留原有介绍。" : ""}`;
  if (lookup?.status === "not-found")
    return a.description
      ? "本次未找到可靠更新，已保留原有介绍。"
      : "未找到可核实的专辑介绍，可以稍后重试。";
  if (a.description) return "介绍已保存在本机，可离线阅读。";
  return "尚未查询专辑介绍。";
}
function updateIntroductionStatus() {
  const job = library.introductions;
  const running = introductionsStarting || !!job?.running;
  const button = document.querySelector<HTMLButtonElement>(
    "#introduction-refresh",
  );
  if (button) {
    button.disabled = running || !apiAvailable || !library.albums.length;
    button.textContent = running
      ? "正在查询专辑介绍…"
      : "查询 / 更新专辑介绍 ↗";
  }
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '[data-action="introduction-album"]',
  ))
    control.disabled = running || !apiAvailable;
  for (const feedback of document.querySelectorAll<HTMLElement>(
    "[data-introduction-feedback]",
  )) {
    const album = albums.find(
      (a) => a.id === feedback.dataset.introductionFeedback,
    );
    if (album)
      feedback.textContent = running
        ? "正在查询专辑介绍，已有资料仍可阅读。"
        : introductionAlbumStatus(album);
  }
  const progress = document.querySelector<HTMLProgressElement>(
    "#introduction-progress",
  );
  if (progress) {
    progress.hidden = !running;
    progress.max = Math.max(1, job?.total || 0);
    progress.value = job?.completed || 0;
    if (introductionsStarting && !job?.running)
      progress.removeAttribute("value");
  }
  const missing = library.albums.filter((album) => !album.description?.trim());
  const coverage = document.querySelector<HTMLElement>(
    "#introduction-coverage",
  );
  if (coverage)
    coverage.textContent = `已有介绍 ${library.albums.length - missing.length} / ${library.albums.length} 张 · 尚缺 ${missing.length} 张`;
  const status = document.querySelector<HTMLElement>("#introduction-status");
  if (status)
    status.textContent = !apiAvailable
      ? "本地音乐服务尚未连接，连接后可查询介绍。"
      : introductionRequestError
        ? `无法开始查询：${introductionRequestError}`
        : !library.albums.length
          ? "扫描本地音乐文件夹后，即可查询专辑介绍。"
          : introductionsStarting
            ? "正在提交专辑介绍查询…"
            : job?.running
              ? `已处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张${job.currentAlbum ? `\n正在查询：${job.currentAlbum}` : ""}`
              : job?.error
                ? `查询未完成：${job.error}`
                : job && job.total > 0
                  ? `上次查询：处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张 · 未找到可靠资料 ${job.notFound} 张 · 查询失败 ${job.failed} 张`
                  : "查询会核对专辑、歌手与年份；无法确认的结果不会覆盖已有介绍。";
  const details = document.querySelector<HTMLDetailsElement>(
    "#introduction-missing",
  );
  if (details) {
    details.hidden = !missing.length;
    details.querySelector("summary")!.textContent =
      `查看尚缺介绍的 ${missing.length} 张专辑`;
    details.querySelector("ul")!.innerHTML = missing
      .map(
        (album) =>
          `<li><strong>${esc(album.title)}</strong><span>${esc(album.artist)} · ${esc(introductionAlbumStatus(album))}</span></li>`,
      )
      .join("");
  }
}
function producerBlock(a: MusicAlbum) {
  return `<section class="producer-section"><div><small>ALBUM CREDITS / 制作人员</small>${!demo ? '<button data-action="enrich-album">补充在线资料 ↗</button>' : ""}</div>${a.producers.length ? `<dl>${a.producers.map((p) => `<div><dt>${esc(p.role)}${p.trackTitle ? ` · ${esc(p.trackTitle)}` : ""}</dt><dd>${esc(p.name)}</dd></div>`).join("")}</dl>` : "<p>暂无制作资料。本地标签优先，MusicBrainz 资料可查询并缓存在本机。</p>"}${a.online?.status === "uncertain" ? "<p>找到多个可能的发行版本，暂未自动采用资料。</p>" : ""}${a.online?.error ? `<p>${esc(a.online.error)}</p>` : ""}</section>`;
}
function updatePlayingRows() {
  document
    .querySelectorAll<HTMLButtonElement>("[data-track]")
    .forEach((row) => {
      const active = row.dataset.track === playerState?.currentTrack?.id;
      row.classList.toggle("playing", active);
      row.setAttribute("aria-current", String(active));
    });
}
let lastPlayerError = "";
const transportTitleMotion = setupTransportTitle(
  $("#transport-track"),
  $("#transport-track-label"),
);
transportTitleMotion.setReduced(preferences.reduced);
const transportSeek = $<HTMLInputElement>("#transport-seek");
const transportTime = $("#transport-time");
const transportScrub = $("#transport-scrub");
let scrubDragging = false;
function syncTransportScrub(state: MusicPlayerState) {
  const active = !!state.currentTrack &&
    (state.transport === "playing" || state.transport === "paused" || state.transport === "loading");
  transportScrub.hidden = !active;
  if (!active) return;
  const duration = Math.max(0, state.duration);
  const current = Math.max(0, Math.min(state.currentTime, duration || state.currentTime));
  transportTime.textContent = `${time(current)} / ${time(duration)}`;
  if (!scrubDragging) {
    const ratio = duration > 0 ? current / duration : 0;
    transportSeek.value = String(Math.round(ratio * 1000));
    transportSeek.setAttribute("aria-valuetext", `${time(current)} / ${time(duration)}`);
  }
}
transportSeek.addEventListener("pointerdown", () => {
  scrubDragging = true;
});
transportSeek.addEventListener("pointerup", () => {
  scrubDragging = false;
  const duration = playerState?.duration ?? 0;
  if (duration > 0) player.seek((Number(transportSeek.value) / 1000) * duration);
});
transportSeek.addEventListener("change", () => {
  scrubDragging = false;
  const duration = playerState?.duration ?? 0;
  if (duration > 0) player.seek((Number(transportSeek.value) / 1000) * duration);
});
transportSeek.addEventListener("input", () => {
  const duration = playerState?.duration ?? 0;
  if (duration > 0) {
    const preview = (Number(transportSeek.value) / 1000) * duration;
    transportTime.textContent = `${time(preview)} / ${time(duration)}`;
  }
});
player.subscribe((state) => {
  playerState = state;
  const titleVisible = !!state.currentTrack &&
    (state.transport === "playing" || state.transport === "paused" || state.transport === "loading");
  transportTitleMotion.update(state.currentTrack?.title ?? "", titleVisible);
  syncTransportScrub(state);
  $("#play-pause").setAttribute("aria-pressed", String(state.playing));
  $("#play-pause").setAttribute(
    "aria-label",
    state.playing ? "暂停" : "播放",
  );
  $("#play-pause").title = state.currentTrack
    ? `${state.playing ? "暂停" : "播放"}：${state.currentTrack.title}`
    : "播放当前专辑";
  if (state.error && state.error !== lastPlayerError) notify(state.error);
  lastPlayerError = state.error || "";
  // Lyrics follow playback when the open album owns the playing track; this is
  // a no-op comparison on every other update.
  const playing = state.currentTrack;
  const album = currentAlbum();
  if (playing && album && playing.albumId === album.id && playing.id !== lyricsPane.trackId)
    lyricsPane.setTrack(lyricTarget(album));
  // The lyrics pane reuses this stream instead of starting a second timer; the
  // clock only advances for the track the pane is actually showing.
  lyricsPane.setClock(
    playing && playing.id === lyricsPane.trackId ? state.currentTime : 0,
  );
  // The settings preview follows the same clock when its toggle is on.
  previewClock = state.currentTime;
  if (previewFollow) void syncPreviewFollow();
  updatePlayingRows();
});

let panelFocus: HTMLElement | null = null;
let panelTransition: SurfaceTransition | undefined,
  panelClosing = false,
  pendingPanelAfter: (() => void) | undefined;
function closePanel(after?: () => void) {
  if (!panel) {
    after?.();
    return;
  }
  pendingPanelAfter = after;
  if (panelClosing) return;
  panelClosing = true;
  panelTransition?.hide(preferences.reduced, () => {
    panel = null;
    panelClosing = false;
    panelTransition?.dispose();
    panelTransition = undefined;
    $("#music-panel-root").innerHTML = "";
    for (const node of [
      $("#music-browse"),
      $("#music-detail"),
      $(".music-header"),
      $("#three-scene"),
    ])
      node.inert = false;
    $("#music-browse").inert = presentation.phase !== "archive";
    if (overview) $("#music-browse").inert = true;
    $("#music-overview").inert = !overview;
    $<HTMLButtonElement>('[data-action="overview"]').inert = overview;
    $("#music-detail").inert = presentation.phase !== "detail";
    panelFocus?.focus({ preventScroll: true });
    const next = pendingPanelAfter;
    pendingPanelAfter = undefined;
    next?.();
  });
}
function openPanel(next: Panel) {
  if (!next) return closePanel();
  cancelTrackReveal();
  panelTransition?.dispose();
  pendingPanelAfter = undefined;
  panelClosing = false;
  if (!panel) panelFocus = document.activeElement as HTMLElement;
  panel = next;
  $("#music-overview").inert = true;
  $<HTMLButtonElement>('[data-action="overview"]').inert = true;
  const titles = {
    library: ["MUSIC LIBRARY", "本地音乐库"],
    search: ["FIND MUSIC", "搜索专辑与歌曲"],
    settings: ["SYSTEM SETTINGS", "播放与画质"],
  };
  $("#music-panel-root").innerHTML =
    `<div class="music-panel-scrim" data-action="dismiss-panel"><section class="music-panel" role="dialog" aria-modal="true" aria-labelledby="music-panel-title"><div class="panel-heading"><div><small>${titles[next][0]}</small><h2 id="music-panel-title">${titles[next][1]}</h2></div><button data-action="close-panel" aria-label="关闭">×</button></div><div id="panel-body"></div></section></div>`;
  for (const node of [
    $("#music-browse"),
    $("#music-detail"),
    $(".music-header"),
    $("#three-scene"),
  ])
    node.inert = true;
  const scrim = $(".music-panel-scrim");
  scrim.hidden = true;
  panelTransition = new SurfaceTransition(scrim, $(".music-panel"));
  panelTransition.show(preferences.reduced);
  effects.play("page-open");
  if (next === "library") renderLibraryPanel();
  if (next === "search") renderSearchPanel();
  if (next === "settings") renderSettingsPanel();
  (
    document.querySelector<HTMLElement>("#album-search") ||
    $("#music-panel-root button")
  )?.focus({ preventScroll: true });
}
function renderLibraryPanel() {
  $("#panel-body").innerHTML =
    `<p class="panel-intro">根目录中的每首单曲各是一张卡片，优先使用自身内嵌封面。子文件夹按专辑展示，优先使用文件夹封面。</p><label class="field-label" for="music-roots">音乐文件夹<span>多个目录各占一行</span></label><textarea id="music-roots" rows="3" placeholder="/Users/你的用户名/Music">${esc(library.roots.map((r) => r.path).join("\n"))}</textarea><div class="panel-actions"><button class="primary-button" data-action="scan">保存目录并扫描 ↗</button><button data-action="rescan">重新扫描</button></div><div id="scan-status" class="scan-status"></div><div class="library-metrics"><div><b>${library.albums.length}</b><span>专辑</span></div><div><b>${library.albums.reduce((n, a) => n + a.tracks.length, 0)}</b><span>曲目</span></div><div><b>${library.genres.filter((g) => library.albums.some((a) => a.genreId === g.id)).length}</b><span>流派</span></div></div><section class="panel-section"><h3>专辑详情与背景</h3><p>逐张读取国内可正常访问的公开元数据源（QQ 音乐 / 网易云音乐 / 百度百科 / MusicBrainz），补充专辑简介、发行背景、发行日期与线上专辑类型，每条内容都附出处并缓存 30 天。音乐文件不会上传。</p><button data-action="online-library" class="text-button">逐张补充专辑详情与背景 ↗</button><p id="online-status" class="scan-status" role="status" aria-live="polite"></p></section><section class="panel-section"><h3>在线资料与本地分类</h3><p>向 MusicBrainz 查询专辑名称与艺术家，补充流派和制作人员；音乐文件留在本机。已有资料使用缓存，人工分类优先保留。</p><button data-action="enrich-library" class="text-button">补充缺失的在线资料 ↗</button><button data-action="edit-genres" class="text-button">编辑流派归并规则 ↗</button></section><section class="panel-section"><h3>封面显示</h3><p>方形、竖版、横版封面均保持原始比例，完整放入卡片正面。没有封面时显示专辑名称占位，不使用其他专辑的图片。</p>${!library.albums.length ? '<button data-action="demo" class="text-button">查看演示封面 ↗</button>' : ""}</section>`;
  updateScanStatus();
  const configSection = document.createElement("section");
  configSection.className = "panel-section";
  configSection.id = "online-config";
  $("#panel-body").append(configSection);
  void (async () => {
    try {
      const config = await request<{
        musicBrainzContact?: string;
        musicBrainzConfigured?: boolean;
        onlineEnabled?: boolean;
      }>("/api/config");
      if (!configSection.isConnected) return;
      configSection.innerHTML = `<h3>资料库连接</h3><label class="field-label" for="metadata-contact">MusicBrainz 联系邮箱或项目网址</label><input id="metadata-contact" type="text" value="${esc(config.musicBrainzContact || "")}" placeholder="你的联系邮箱或公开项目网址"><p>按 MusicBrainz 要求用于标识本应用的资料请求，不用于注册或订阅。</p><label class="settings-row"><span>扫描后自动补充新专辑资料<small>已有缓存不重复查询；断网仍可浏览与播放</small></span><input type="checkbox" id="online-enabled" ${config.onlineEnabled ? "checked" : ""}></label><button class="text-button" data-action="save-online">保存资料库设置 ↗</button><p>${config.musicBrainzConfigured ? "资料库请求标识已配置。" : "尚未配置；本地曲库和播放已可使用。"}「线上补充详情与背景」是手动操作，未勾选上面这项也可以用。</p>`;
    } catch (error) {
      if (configSection.isConnected)
        configSection.innerHTML = `<p>${esc((error as Error).message)}</p>`;
    }
  })();
}
function updateScanStatus() {
  const el = document.querySelector("#scan-status");
  if (el)
    el.textContent = library.scan.running
      ? "正在扫描，已有曲库可以继续浏览…"
      : library.scan.error ||
        library.roots
          .filter((r) => r.status === "offline")
          .map((r) => `${r.path} 暂时离线，原索引已保留。`)
          .join("\n") ||
        (library.scan.finishedAt
          ? `上次扫描 ${new Date(library.scan.finishedAt).toLocaleString("zh-CN")}`
          : "尚未扫描音乐目录。");
}
function renderSearchPanel() {
  $("#panel-body").innerHTML =
    `<input class="album-search" id="album-search" type="search" placeholder="专辑、歌曲、歌手、流派…" aria-label="搜索专辑与歌曲"><div class="genre-filters"><button data-filter="" class="active">全部</button>${genres
      .filter((g) => albums.some((a) => a.genreId === g.id))
      .map((g) => `<button data-filter="${esc(g.id)}">${esc(g.name)}</button>`)
      .join("")}</div><div id="album-results"></div>`;
  renderSearchResults();
}
let searchGenre = "";
function renderSearchResults() {
  const query = ($<HTMLInputElement>("#album-search")?.value || "")
    .trim()
    .toLocaleLowerCase();
  const results: string[] = [];
  for (const a of albums) {
    if (searchGenre && a.genreId !== searchGenre) continue;
    if (!query || `${a.title} ${a.artist} ${genreName(a.genreId)}`.toLocaleLowerCase().includes(query)) {
      results.push(`<button class="album-result" data-album="${esc(a.id)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(a.title)}</strong><small>${esc(a.artist)} · ${esc(genreName(a.genreId))}</small></span><em>专辑</em><i>↗</i></button>`);
    }
    if (!query) continue;
    for (const track of a.tracks) {
      if (!`${track.title} ${track.artist}`.toLocaleLowerCase().includes(query)) continue;
      // Preserve the exact song identity; selecting a result navigates without playing.
      results.push(`<button class="album-result song-result" data-album="${esc(a.id)}" data-search-track="${esc(track.id)}" aria-label="定位歌曲 ${esc(track.title)}，${esc(a.title)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(track.title)}</strong><small>${esc(track.artist)} · ${esc(a.title)}</small></span><em>歌曲</em><i>↗</i></button>`);
    }
  }
  $("#album-results").innerHTML = results.length
    ? results.join("")
    : '<div class="no-results">没有找到专辑或歌曲。</div>';
}
function nativeKernelMarkup() {
  const native = getNativePlayback();
  const prefs = loadNativeKernelPrefs();
  const ok = native.available;
  return `<section class="panel-section" id="audio-kernel-settings">
    <h3>播放内核</h3>
    <p class="scan-status" id="kernel-status">状态：${
      ok
        ? "原生 libmpv 已连接（支持 DSF/DFF 与主流格式）"
        : "未检测到原生宿主，当前回退浏览器解码"
    }</p>
    <label class="settings-row"><span>WASAPI 独占<small>比特完美直送 USB DAC；板载声卡建议关闭，避免挤掉 BGM</small></span>
      <input type="checkbox" id="audio-exclusive" ${prefs.exclusive ? "checked" : ""}></label>
    <label class="settings-row"><span>输出设备<small>留空 = 系统默认</small></span>
      <select id="audio-device" aria-label="输出设备">
        <option value="" ${!prefs.deviceId ? "selected" : ""}>系统默认设备</option>
      </select></label>
    <div class="panel-actions">
      <button class="text-button" data-action="refresh-audio-devices">刷新设备列表 ↗</button>
      <button class="text-button" data-action="kernel-diagnose">诊断播放内核 ↗</button>
    </div>
    <p id="kernel-note">Windows 专用：歌曲经宿主 libmpv 输出。独占模式下浏览器氛围 BGM 可能无声，属正常现象。</p>
  </section>`;
}

let deviceListBound = false;
function refreshAudioDeviceList() {
  const native = getNativePlayback();
  const select = document.querySelector<HTMLSelectElement>("#audio-device");
  if (!select) return;
  if (!deviceListBound) {
    deviceListBound = true;
    native.subscribe((event) => {
      if (event.type !== "devices") return;
      const el = document.querySelector<HTMLSelectElement>("#audio-device");
      if (!el) return;
      const current = el.value;
      el.innerHTML =
        `<option value="">系统默认设备</option>` +
        event.devices
          .map(
            (d) =>
              `<option value="${esc(d.id)}" ${d.id === current ? "selected" : ""}>${esc(d.name)}</option>`,
          )
          .join("");
    });
  }
  native.listDevices();
}

function renderSettingsPanel() {
  $("#panel-body").innerHTML =
    `<section class="panel-section"><h3>外观主题</h3><div class="theme-cards">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-pressed="${preferences.theme === t}" class="${t}"><i></i><strong>${themeNames[t]}</strong><span>${t === "day" ? "暖白玻璃与日光" : "极简星空与透光白卡"}</span></button>`).join("")}</div></section>
    <section class="panel-section"><h3>音乐库排列</h3><label class="settings-row"><span>排列方式<small>切换后自动刷新页面</small></span><select id="music-sort" aria-label="音乐库排列方式">${(["genre", "artist", "album"] as MusicSortMode[]).map((value) => `<option value="${value}" ${preferences.sortMode === value ? "selected" : ""}>${sortLabels[value].name}</option>`).join("")}</select></label><p>按歌手时，同一歌手的专辑放在同一列；按专辑名时，按拼音或字母顺序排列，每 12 张一列。</p></section>
    <section class="panel-section"><h3>高级设置 · 专辑阵列</h3><label class="settings-row"><span>专辑列显示<small>改变阵列数量，保留当前选择和播放</small></span><select id="music-array-mode" aria-label="专辑列显示方式"><option value="filled" ${preferences.arrayMode === "filled" ? "selected" : ""}>填充画面</option><option value="realistic" ${preferences.arrayMode === "realistic" ? "selected" : ""}>真实专辑列</option></select></label><p>填充画面：循环摆放封面，铺满视野。真实专辑列：每张专辑只摆放一次，各列独立居中；上下浏览到本列首尾时停止。</p><label class="settings-row"><span>保留每列浏览位置<small>开启后记住每列上次的位置</small></span><input type="checkbox" id="remember-column-position" ${preferences.rememberColumnPosition ? "checked" : ""}></label></section>
    <section class="panel-section" id="introduction-settings"><h3>专辑介绍</h3><p>从公开百科查询并更新专辑介绍，附上资料来源。介绍保存在本机，不需要配置 MusicBrainz 联系信息；音乐文件不会上传。</p><p id="introduction-coverage"></p><button class="primary-button" id="introduction-refresh" data-action="introductions-library">查询 / 更新专辑介绍 ↗</button><progress id="introduction-progress" aria-label="专辑介绍查询进度" max="1" value="0" hidden></progress><p id="introduction-status" class="scan-status" role="status" aria-live="polite"></p><details id="introduction-missing" hidden><summary></summary><ul></ul></details></section>
    ${qualityMarkup(renderQuality)}
    <section class="panel-section"><h3>动效与显示</h3><label class="settings-row"><span>减少动态效果<small>简化镜头、文字加载和页签过渡</small></span><input type="checkbox" id="reduced-motion" ${preferences.reduced ? "checked" : ""}></label><label class="settings-row"><span>空闲时停止绘制<small>2 分钟无操作后暂停三维渲染，移动鼠标或按键立即恢复；省电与降低风扇转速</small></span><input type="checkbox" id="idle-stop" ${preferences.idleStop ? "checked" : ""}></label><label class="settings-row"><span>玻璃雾度<small>100% 为原始质感；调高更朦胧，调低更通透。只影响玻璃外壳</small></span><span class="settings-slider"><input type="range" id="glass-frost" aria-label="玻璃雾度" min="0" max="200" step="5" value="${preferences.glassFrost}"><output id="glass-frost-output">${preferences.glassFrost}%</output></span></label><label class="settings-row"><span>锐化强度<small>0% 关闭。三维画面按较低分辨率渲染再放大，锐化找回局部对比；只作用于三维场景</small></span><span class="settings-slider"><input type="range" id="sharpen" aria-label="锐化强度" min="0" max="100" step="5" value="${preferences.sharpen}"><output id="sharpen-output">${preferences.sharpen}%</output></span></label><button class="text-button" data-action="fullscreen">切换全屏 ↗</button></section>
    <section class="panel-section"><h3>声音</h3><label class="settings-row"><span>歌曲音量</span><input type="range" id="volume" aria-label="歌曲音量" min="0" max="100" value="${Math.round(preferences.volume * 100)}"></label><label class="settings-row"><span>歌曲衔接<small>选择切换歌曲时的音量过渡</small></span><select id="song-fade-setting" aria-label="歌曲衔接方式"><option value="fade-out" ${preferences.songTransition === "fade-out" ? "selected" : ""}>淡出但不淡入</option><option value="fade-in-out" ${preferences.songTransition === "fade-in-out" ? "selected" : ""}>淡出淡入</option><option value="gapless" ${preferences.songTransition === "gapless" ? "selected" : ""}>无缝播放</option></select></label><label class="settings-row"><span>界面音效<small>玻璃卡片与终端操作</small></span><input type="checkbox" id="sound-setting" ${preferences.sound ? "checked" : ""}></label><label class="settings-row"><span>音效音量</span><input type="range" id="sound-volume" aria-label="音效音量" min="0" max="100" value="${Math.round(preferences.soundVolume * 100)}"></label><label class="settings-row"><span>氛围 BGM<small>专辑开始前淡出，停止后淡入</small></span><input type="checkbox" id="bgm-setting" ${preferences.bgm ? "checked" : ""}></label><label class="settings-row"><span>BGM 音量</span><input type="range" id="bgm-volume" aria-label="BGM 音量" min="0" max="100" value="${Math.round(preferences.bgmVolume * 100)}"></label><button class="text-button" data-action="sound-preview">试听界面音效 ↗</button></section>
    ${lyricsMarkup(lyricSettings, previewTracks())}
    ${nativeKernelMarkup()}
    <section class="panel-section"><h3>开发与资源</h3><p>音乐适配与维护：<a href="https://github.com/RonaldDeng/Rhine-Music-Demo" target="_blank" rel="noopener">RonaldDeng ↗</a><br>原版界面：<a href="https://github.com/LBEILC/RhineLabUI" target="_blank" rel="noopener">LBEILC / RhineLabUI ↗</a></p><p><a href="/licenses/project-mit.txt" target="_blank" rel="noopener">代码 MIT 许可 ↗</a> · <a href="https://github.com/RonaldDeng/Rhine-Music-Demo/blob/v0.2.0/NOTICE.md" target="_blank" rel="noopener">版权与资源说明 ↗</a></p><a href="/?original=1&scene=archive" target="_blank" rel="noopener">打开原版档案界面 ↗</a><p><a href="/fonts/MiSans-license.pdf" target="_blank" rel="noopener">MiSans 字体许可 ↗</a></p></section>`;
  if (lightingLab)
    $("#panel-body").insertAdjacentHTML(
      "beforeend",
      `<section class="panel-section" id="developer-settings">
      <h3>开发者调试模式</h3>
      <label class="settings-row"><span>光效调试面板<small>调节光带节奏、亮度和范围</small></span><input type="checkbox" id="developer-mode" aria-label="光效调试面板" ${preferences.developerMode ? "checked" : ""}></label>
      <label class="settings-row"><span>动画速度调试面板<small>统一调节专辑、镜头、文字与光带速度</small></span><input type="checkbox" id="developer-motion" aria-label="动画速度调试面板" ${preferences.motionDebug ? "checked" : ""}></label>
      <p>两个面板可以同时打开。调节即时生效、自动保存在本机，无需刷新；收起或关闭面板仍保留效果。</p>
      <button class="text-button" data-action="lighting-debug" ${preferences.developerMode ? "" : "hidden"}>打开光效调试面板 ↗</button>
      <button class="text-button" data-action="motion-debug" ${preferences.motionDebug ? "" : "hidden"}>打开动画速度调试面板 ↗</button>
    </section>`,
    );
  updateQuality();
  updateIntroductionStatus();
  syncLyricsUI(lyricSettings);
  void initPreviewControls();
  void refreshAudioDeviceList();
}
function updateQuality() {
  renderQuality = normalizeQuality(renderQuality);
  preferences.renderQuality = renderQuality;
  scene?.setQuality(renderQuality);
  viewer?.setQuality(renderQuality);
  syncQualityUI(renderQuality);
  const summary = document.querySelector("#quality-summary");
  if (summary)
    summary.textContent = `渲染 ${renderQuality.scale}% · 像素上限 ${renderQuality.pixelRatio}× · ${renderQuality.antialias === "off" ? "原始抗锯齿" : "SMAA"}`;
  savePrefs();
}
async function editGenres() {
  const body = document.querySelector("#panel-body");
  try {
    const rules = await request<GenreRules>("/api/genre-rules");
    if (!body?.isConnected || panel !== "library") return;
    body.innerHTML = `<p class="panel-intro">这里编辑展示流派、别名和专辑人工分类。保存后重新归并本地索引，不修改音频标签。</p><label class="field-label" for="genre-json">本地流派规则</label><textarea id="genre-json" class="json-editor" spellcheck="false">${esc(JSON.stringify(rules, null, 2))}</textarea><div class="panel-actions"><button data-action="save-genres" class="primary-button">保存并应用</button><button data-action="library">返回音乐库</button></div><p id="genre-error" role="alert"></p>`;
  } catch (error) {
    notify((error as Error).message);
  }
}
async function scan(saveRoots = false) {
  if (scanSubmitting || library.scan.running) return;
  scanSubmitting = true;
  clearTimeout(scanRefreshTimer);
  scanRefreshTimer = undefined;
  ++libraryStateVersion;
  try {
    const roots = saveRoots
      ? $<HTMLTextAreaElement>("#music-roots")
          .value.split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const next = await request<MusicLibrary>("/api/library/scan", roots ? { roots } : {});
    ++libraryStateVersion; // Discard polls started before this accepted scan.
    notify("开始扫描音乐库，已有专辑可以继续浏览。");
    await receiveLibrary(next);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 600);
  } catch (error) {
    notify((error as Error).message);
  } finally {
    scanSubmitting = false;
  }
}
async function enrich(one = false) {
  if (demo) return;
  try {
    await request(
      "/api/library/enrich",
      one ? { albumIds: [currentAlbum()!.id] } : {},
    );
    notify("已开始补充流派和制作资料，结果将缓存在本机。");
    await loadLibrary();
  } catch (error) {
    notify((error as Error).message);
  }
}
async function queryIntroductions(one = false) {
  const album = currentAlbum();
  if (demo || !library.albums.length || (one && !album)) return;
  if (introductionsStarting || library.introductions?.running) {
    notify("专辑介绍正在查询，进度可在设置中查看。");
    return;
  }
  introductionsStarting = true;
  introductionRequestError = "";
  updateIntroductionStatus();
  try {
    const next = await request<MusicLibrary>("/api/library/introductions", {
      ...(one ? { albumIds: [album!.id] } : {}),
      force: true,
    });
    // A GET started before this accepted job must not restore an older snapshot.
    libraryStateVersion++;
    apiAvailable = true;
    await receiveLibrary(next);
    const job = next.introductions;
    notify(
      job?.running
        ? `${one ? "这张专辑" : "音乐库"}的介绍查询已开始，可在设置中查看进度。`
        : job?.error ||
            (job && job.total > 0
              ? `专辑介绍查询完成：更新 ${job.updated} 张，未找到可靠资料 ${job.notFound} 张，查询失败 ${job.failed} 张。`
              : "当前没有需要查询的专辑。"),
    );
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 800);
  } catch (error) {
    introductionRequestError = (error as Error).message;
    notify(introductionRequestError);
  } finally {
    introductionsStarting = false;
    updateIntroductionStatus();
  }
}
function playAlbum(id?: string) {
  const a = currentAlbum();
  if (!a?.tracks.length || a.offline) return;
  void player.play(id || a.tracks[0].id, a.tracks);
}

document.addEventListener("click", (e) => {
  if (boot?.active) return;
  const target = (e.target as HTMLElement).closest<HTMLElement>(
    "button, [data-action]",
  );
  if (!target) return;
  if (target.dataset.overviewLane !== undefined) {
    overviewUI.expand(Number(target.dataset.overviewLane));
    return;
  }
  if (target.dataset.overviewEnterLane !== undefined) {
    const lane = Number(target.dataset.overviewEnterLane);
    if (!overviewUI.canEnter(lane)) return;
    const targetColumn = resolveColumnSelection(lane);
    const navigation = targetColumn.row === undefined ? undefined : {
      cell: scene?.musicColumnCell(lane, targetColumn.row) ?? { lane, row: targetColumn.row },
      guided: true,
    };
    // The shared preference chooses an album; reveal browse text only after the
    // rail and near camera settle. Entry never opens album details.
    select(targetColumn.index, navigation, false);
    setOverview(false);
    return;
  }
  if (target.dataset.action === "dismiss-panel" && e.target !== target) return;
  if (target.dataset.theme) {
    setTheme(target.dataset.theme as Theme);
    return;
  }
  if (target.dataset.track) {
    playAlbum(target.dataset.track);
    return;
  }
  if (target.dataset.select) {
    const rulerStep = Number(target.dataset.rulerStep);
    select(Number(target.dataset.select),
      target.dataset.rulerStep !== undefined && Number.isInteger(rulerStep)
        ? { axis: "row", direction: rulerStep } : undefined);
    return;
  }
  if (target.dataset.album) {
    revealAlbum(target.dataset.album, target.dataset.searchTrack ?? undefined);
    return;
  }
  if (target.dataset.tab) {
    setTab(target.dataset.tab as "tracks" | "about");
    return;
  }
  if (target.dataset.filter !== undefined) {
    searchGenre = target.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          (b as HTMLElement).dataset.filter === searchGenre,
        ),
      );
    renderSearchResults();
    return;
  }
  const action = target.dataset.action;
  if (["library", "search", "settings"].includes(action || "")) {
    searchGenre = "";
    openPanel(action as Panel);
    return;
  }
  switch (action) {
    case "overview-return":
      setOverview(false);
      break;
    case "overview":
      setOverview(!overview);
      break;
    case "lighting-debug":
      closePanel(() => {
        setMode("archive");
        lightingControls?.focus();
      });
      break;
    case "motion-debug":
      closePanel(() => {
        setMode("archive");
        motionControls?.focus();
      });
      break;
    case "close-panel":
    case "dismiss-panel":
      closePanel();
      break;
    case "open":
      setMode("detail");
      break;
    case "back":
      setMode("archive");
      break;
    case "model-viewer":
      // Temporarily unavailable for the simplified CD shell (no inner assembly).
      break;
    case "sound-preview":
      effects.play("page-open");
      break;
    case "locate-playing": {
      const track = playerState.currentTrack;
      if (track) revealAlbum(track.albumId, track.id, { reuseOpenAlbum: true });
      break;
    }
    case "refresh-audio-devices":
      refreshAudioDeviceList();
      notify("已请求刷新输出设备列表。");
      break;
    case "kernel-diagnose": {
      const native = getNativePlayback();
      native.log(`diagnose ${native.describe()} backend=${playerState.backend}`);
      native.ping();
      notify(
        `${native.available ? "原生内核已连接" : "原生内核未连接，使用浏览器解码"} · 详见 mpv-playback.log`,
      );
      break;
    }
    case "fullscreen":
      void (
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen()
      ).catch(() => notify("当前浏览器无法进入全屏。"));
      break;
    case "prev":
      stepAlbum(-1);
      break;
    case "next":
      stepAlbum(1);
      break;
    case "genre-prev":
      stepGenre(-1);
      break;
    case "genre-next":
      stepGenre(1);
      break;
    case "genres":
      openPanel("search");
      break;
    case "play-pause":
      playerState.currentTrack ? void player.toggle() : playAlbum();
      break;
    case "stop":
      player.stop();
      break;
    case "scan":
      void scan(true);
      break;
    case "rescan":
      void scan();
      break;
    case "enrich-album":
      void enrich(true);
      break;
    case "enrich-library":
      void enrich();
      break;
    case "introduction-album":
      void queryIntroductions(true);
      break;
    case "introductions-library":
      void queryIntroductions();
      break;
    case "online-album":
      void loadOnline();
      break;
    case "online-library":
      void loadOnlineLibrary();
      break;
    case "edit-genres":
      void editGenres();
      break;
    case "lyric-reset":
      Object.assign(lyricSettings, defaultLyricsSettings);
      applyLyricSettings();
      markLyricPreset("");
      notify("歌词参数已恢复默认。");
      break;
    case "lyric-color-reset":
      // "Follow the theme" is the absence of a value, not a stored colour, so the
      // property is removed and the stylesheet fallback takes over again.
      if (target.dataset.lyricKey === "accent") lyricSettings.accent = "";
      else lyricSettings.color = "";
      applyLyricSettings();
      break;
    case "lyric-preset": {
      // A preset is a full look, not a delta: it starts from the defaults so it
      // is deterministic no matter what the user had dialled in before.
      Object.assign(
        lyricSettings,
        applyLyricPatch(lyricSettings, {
          ...defaultLyricsSettings,
          ...lyricPresetPatch(target.dataset.preset ?? ""),
        }),
      );
      applyLyricSettings();
      markLyricPreset(target.dataset.preset ?? "");
      break;
    }
    case "lyric-group-reset": {
      const patch: Partial<typeof lyricSettings> = {};
      for (const key of lyricGroupKeys(target.dataset.lyricGroup ?? "")) {
        (patch as Record<string, unknown>)[key] =
          defaultLyricsSettings[key as keyof typeof lyricSettings];
      }
      Object.assign(lyricSettings, applyLyricPatch(lyricSettings, patch));
      applyLyricSettings();
      break;
    }
    case "lyric-row-reset": {
      const key = target.dataset.lyricRow as keyof typeof lyricSettings;
      if (key && key in defaultLyricsSettings) {
        Object.assign(
          lyricSettings,
          applyLyricPatch(lyricSettings, { [key]: defaultLyricsSettings[key] }),
        );
        applyLyricSettings();
      }
      break;
    }
    case "lyric-export":
      void exportLyricSettings();
      break;
    case "lyric-import":
      void importLyricSettings();
      break;
    case "save-online":
      void (async () => {
        try {
          await request("/api/config", {
            musicBrainzContact:
              $<HTMLInputElement>("#metadata-contact").value.trim(),
            onlineEnabled: $<HTMLInputElement>("#online-enabled").checked,
          });
          notify("资料库设置已保存。可以开始补充专辑资料。");
        } catch (error) {
          notify((error as Error).message);
        }
      })();
      break;
    case "save-genres":
      void (async () => {
        const editor = $<HTMLTextAreaElement>("#genre-json");
        try {
          const body = JSON.parse(editor.value);
          await request("/api/genre-rules", body);
          await loadLibrary(true);
          notify("分类规则已保存并应用。");
          if (editor.isConnected && panel === "library") renderLibraryPanel();
        } catch (error) {
          const errorNode = document.querySelector("#genre-error");
          if (editor.isConnected && errorNode)
            errorNode.textContent = (error as Error).message;
          else notify((error as Error).message);
        }
      })();
      break;
    case "demo":
      demo = true;
      closePanel(() => void applyLibrary());
      break;
  }
});
document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  // The lyric controls are sliders and colour pickers, so `input` already gives
  // live feedback; the pane and the in-panel preview are re-tokened together so
  // the sample can never disagree with what will play.
  if (el.dataset.lyric || el.dataset.lyricColor) {
    if (applyLyricControl(el, lyricSettings)) applyLyricSettings();
  }
  if (el.dataset.quality && el.type === "range") {
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]: Number(el.value),
    });
    updateQuality();
  }
  if (el.id === "bgm-volume") {
    preferences.bgmVolume = Number(el.value) / 100;
    player.setBgmVolume(preferences.bgmVolume);
    savePrefs();
  }
  if (el.id === "sound-volume") {
    preferences.soundVolume = Number(el.value) / 100;
    effects.configure({
      sound: preferences.sound,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    if (getNativePlayback().available)
      void getNativePlayback().bgm("sfx-volume", preferences.soundVolume);
    savePrefs();
  }
  if (el.id === "album-search") renderSearchResults();
  if (el.id === "volume") {
    preferences.volume = Number(el.value) / 100;
    player.setVolume(preferences.volume);
    savePrefs();
  }
  if (el.id === "glass-frost") {
    preferences.glassFrost = Number(el.value);
    scene?.setGlassFrost(preferences.glassFrost);
    const out = document.querySelector("#glass-frost-output");
    if (out) out.textContent = `${preferences.glassFrost}%`;
  }
  if (el.id === "sharpen") {
    preferences.sharpen = Number(el.value);
    scene?.setSharpen(preferences.sharpen);
    const out = document.querySelector("#sharpen-output");
    if (out) out.textContent = `${preferences.sharpen}%`;
  }
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  // The lyric preview picker: changing the song reloads its lines; changing the
  // line or the follow toggle just re-renders the sample.
  if (el.dataset.lyricPreview === "track") {
    previewTrackId = el.value;
    previewLine = 0;
    previewLyrics.delete(el.value);
    void (async () => {
      const document = await previewDocument();
      setLyricPreviewLineCount(document.lines.length);
      await renderPreviewLine(0);
    })();
    return;
  }
  if (el.dataset.lyricPreview === "line") {
    previewLine = Number(el.value);
    void renderPreviewLine(previewLine);
    return;
  }
  if (el.dataset.lyricPreview === "follow") {
    previewFollow = el.checked;
    if (previewFollow) void syncPreviewFollow();
    return;
  }
  if (el.id === "music-sort" && ["genre", "artist", "album"].includes(el.value)) {
    if (preferences.sortMode === el.value) return;
    preferences.sortMode = el.value as MusicSortMode;
    savePrefs();
    location.reload();
    return;
  }
  if (el.id === "music-array-mode") {
    preferences.arrayMode = normalizeMusicArrayMode(el.value);
    scene?.setMusicArrayMode(preferences.arrayMode);
    stage.dataset.arrayMode = preferences.arrayMode;
    syncAlbumNavigation();
    savePrefs();
  }
  if (el.id === "remember-column-position") {
    preferences.rememberColumnPosition = el.checked;
    // Changing this preference never navigates or changes playback. Re-enabling
    // starts with the current album while other columns retain their session memory.
    if (el.checked && records[selected]) columnMemory.set(
      archiveColumns[fileLocation(selected).lane], records[selected].id,
    );
    syncAlbumNavigation();
    savePrefs();
  }
  if (el.id === "developer-mode") {
    preferences.developerMode = el.checked;
    lightingControls?.setEnabled(el.checked);
    const debugButton = document.querySelector<HTMLElement>('[data-action="lighting-debug"]');
    if (debugButton) debugButton.hidden = !el.checked;
    savePrefs();
  }
  if (el.id === "developer-motion") {
    preferences.motionDebug = el.checked;
    motionControls?.setEnabled(el.checked);
    const debugButton = document.querySelector<HTMLElement>('[data-action="motion-debug"]');
    if (debugButton) debugButton.hidden = !el.checked;
    savePrefs();
  }
  if (el.id === "quality-preset") {
    preferences.quality = el.value as QualityPreset;
    renderQuality = normalizeQuality(qualityPresets[preferences.quality]);
    updateQuality();
  }
  if (el.dataset.quality) {
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]:
        el.dataset.quality === "antialias" ? el.value : Number(el.value),
    });
    updateQuality();
  }
  if (el.id === "sound-setting") {
    preferences.sound = el.checked;
    effects.configure({
      sound: el.checked,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    if (getNativePlayback().available)
      void getNativePlayback().bgm("sfx-enabled", undefined, el.checked);
    savePrefs();
  }
  if (el.id === "song-fade-setting") {
    preferences.songTransition = normalizeSongTransition(el.value);
    player.setSongTransitionMode(preferences.songTransition);
    savePrefs();
  }
  if (el.id === "reduced-motion") {
    preferences.reduced = el.checked;
    transportTitleMotion.setReduced(el.checked);
    detailSwitch.setReduced(el.checked);
    lyricsPane.setReduced(el.checked);
    if (el.checked) {
      browseTransition.finish();
      detailTransition.finish();
    }
    syncSelectionMotion();
    scene?.setReduced(el.checked);
    stage.classList.toggle("reduce-motion", el.checked);
    updateSelection();
    savePrefs();
  }
  if (el.id === "glass-frost") {
    preferences.glassFrost = Number(el.value);
    scene?.setGlassFrost(preferences.glassFrost);
    savePrefs();
  }
  if (el.id === "sharpen") {
    preferences.sharpen = Number(el.value);
    scene?.setSharpen(preferences.sharpen);
    savePrefs();
  }
  if (el.id === "idle-stop") {
    preferences.idleStop = el.checked;
    // Turning it off must not leave a stopped loop behind: wake it now.
    noteActivity();
    if (!el.checked) armFrame();
    savePrefs();
  }
  if (el.id === "bgm-setting") {
    preferences.bgm = el.checked;
    player.setBgmEnabled(el.checked);
    savePrefs();
  }
  if (el.id === "audio-exclusive") {
    const prefs = loadNativeKernelPrefs();
    prefs.exclusive = el.checked;
    saveNativeKernelPrefs(prefs);
    getNativePlayback().setExclusive(el.checked);
    notify(
      el.checked
        ? "已开启 WASAPI 独占。板载声卡上 BGM 可能无声；USB DAC 更适合此模式。"
        : "已关闭独占，改用共享模式输出。",
    );
  }
  if (el.id === "audio-device") {
    const prefs = loadNativeKernelPrefs();
    prefs.deviceId = el.value || null;
    saveNativeKernelPrefs(prefs);
    getNativePlayback().setDevice(prefs.deviceId);
    notify(prefs.deviceId ? "已切换输出设备。" : "已恢复系统默认输出设备。");
  }
});
document.addEventListener("keydown", (e) => {
  if (boot?.active) return;
  if (viewer?.isOpen) return;
  if (e.key === "Escape") {
    panel ? closePanel() : setMode("archive");
    return;
  }
  if (panel) {
    if (e.key === "Tab") {
      const items = [
        ...document.querySelectorAll<HTMLElement>(
          "#music-panel-root button:not([disabled]), #music-panel-root input, #music-panel-root textarea, #music-panel-root select, #music-panel-root a",
        ),
      ];
      if (!items.length) return;
      const first = items[0],
        last = items.at(-1)!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (
    (e.target as HTMLElement).matches("[role=tab]") &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
  ) {
    e.preventDefault();
    setTab(
      e.key === "Home"
        ? "tracks"
        : e.key === "End"
          ? "about"
          : activeTab === "tracks"
            ? "about"
            : "tracks",
    );
    $(`#tab-${activeTab}`).focus();
    return;
  }
  if (
    (e.target as HTMLElement).matches(
      "input, textarea, select, [contenteditable=true]",
    )
  )
    return;
  if (e.key === "/") {
    e.preventDefault();
    searchGenre = "";
    openPanel("search");
  }
  if (e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    setOverview(!overview);
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepGenre(-1);
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    stepGenre(1);
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    stepAlbum(-1);
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    stepAlbum(1);
  }
  if (e.key === "Enter" && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    setMode("detail");
  }
  if (e.code === "Space" && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    playerState.currentTrack ? void player.toggle() : playAlbum();
  }
});

let lastFrame = 0,
  frameCount = 0;

// Rendering is the expensive part of this application and nothing on the shelf
// needs it while nobody is looking. After two minutes without input the loop
// stops instead of drawing a drifting archive forever; the next pointer or key
// event restarts it. The archive's idle drift is a 0.1-unit sway, so the pause
// is not visible on its own.
const IDLE_STOP_MS = 120_000;
let asleep = false;
let frameArmed = false;
let lastActivity = performance.now();

/** Re-arm the animation loop. Cheap and safe to call repeatedly. */
function armFrame() {
  if (frameArmed) return;
  frameArmed = true;
  requestAnimationFrame(frame);
}

function sleepRender(reason: "idle" | "hidden") {
  if (asleep) return;
  asleep = true;
  stage.dataset.renderSleep = reason;
}

/** Any interaction wakes the scene and restarts the loop on the next frame. */
function noteActivity() {
  lastActivity = performance.now();
  if (!asleep) return;
  asleep = false;
  delete stage.dataset.renderSleep;
  frameCount = 0;
  lastFrame = 0;
  armFrame();
}

// Real interaction wakes the shelf. Keyboard, wheel and touch count as well as
// the pointer: pausing while someone browses with the arrow keys would be a bug,
// not a saving.
for (const type of [
  "pointermove",
  "pointerdown",
  "pointerup",
  "wheel",
  "keydown",
  "touchstart",
]) {
  window.addEventListener(type, noteActivity, { passive: true });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) noteActivity();
});

function frame(ms: number) {
  frameArmed = false;
  if (
    document.hidden ||
    (preferences.idleStop && ms - lastActivity > IDLE_STOP_MS)
  ) {
    // Returning without re-arming is what actually stops the loop, so an idle
    // window costs no animation frames, no GPU time and no battery at all.
    sleepRender(document.hidden ? "hidden" : "idle");
    frameCount = 0;
    lastFrame = ms;
    return;
  }
  if (scene) {
    const opening = boot?.update(ms / 1000);
    if (!viewer?.isOpen) scene.update(ms / 1000, opening?.cinema);
    updateOverview();
    if (overviewRevealPending && !overview && !boot?.active &&
      scene.musicOverviewProgress < .02 && scene.musicArchiveReady) {
      overviewRevealPending = false;
      showBrowseSurface();
    }
    viewer?.update(ms / 1000);
    if (!viewer?.isOpen && !boot?.active) presentation.update();
    const phase = presentation.phase;
    if (stage.dataset.presentation !== phase) stage.dataset.presentation = phase;
    const cameraPhase = scene.musicPresentationPhase;
    if (stage.dataset.cameraPhase !== cameraPhase) stage.dataset.cameraPhase = cameraPhase;
    if (presentation.phase === "detail") {
      documentDecryption.update(
        ms / 1000,
        scene.decryptionFrame,
        preferences.reduced,
        !viewer?.isOpen,
      );
      if (pendingDetailFocus && !panel && !viewer?.isOpen) {
        $("#album-detail-content").focus({ preventScroll: true });
        pendingDetailFocus = false;
      }
      if (pendingTrackReveal && !panel && !viewer?.isOpen &&
        $("#music-detail").dataset.transition === "open" &&
        currentAlbum()?.id === pendingTrackReveal.albumId) {
        const content = $("#album-detail-content");
        const trackId = pendingTrackReveal.trackId;
        pendingTrackReveal = undefined;
        const row = Array.from(content.querySelectorAll<HTMLButtonElement>(".track-row"))
          .find((item) => item.dataset.track === trackId);
        if (row) trackFocus.reveal(content, row, preferences.reduced);
      }
    }
    frameCount++;
    if (ms - lastFrame > 1500) {
      $("#runtime-info").textContent =
        `${Math.round((frameCount * 1000) / (ms - lastFrame))} FPS / ${themeNames[preferences.theme]} / V${appVersion}`;
      // Keep read-only render diagnostics alongside the existing resolution
      // attributes, without adding controls or per-frame DOM work.
      if (!viewer?.isOpen) {
        const { drawCalls, triangles, selectionLight } = scene.getStats();
        $("#three-scene").dataset.renderStats = JSON.stringify({
          drawCalls,
          triangles,
        });
        $("#three-scene").dataset.selectionLight =
          JSON.stringify(selectionLight);
      }
      frameCount = 0;
      lastFrame = ms;
    }
  } else {
    frameCount = 0;
    lastFrame = ms;
  }
  armFrame();
}
async function start() {
  // This local application owns its live index. An old archive PWA must not serve stale UI.
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
  }
  await loadLibrary(true);
  try {
    fit();
    scene = new ArchiveScene($("#three-scene"));
    // Keep a direct visual comparison URL without adding another user setting.
    if (lightingLab || new URLSearchParams(location.search).get("lighting") !== "baseline")
      scene.enableSelectionLighting();
    if (lightingLab) {
      const devPanels = document.createElement("div");
      devPanels.className = "music-dev-panels";
      stage.append(devPanels);
      const closeDebugPanel = (key: "developerMode" | "motionDebug") => {
        preferences[key] = false;
        savePrefs();
        if (panel === "settings") renderSettingsPanel();
        else document.querySelector<HTMLButtonElement>('[data-action="settings"]')?.focus({ preventScroll: true });
      };
      motionControls = setupMotionLab(devPanels, {
        enabled: preferences.motionDebug,
        onChange: (speed) => { preferences.motionSpeed = speed; savePrefs(); },
        onClose: () => closeDebugPanel("motionDebug"),
      });
      lightingControls = setupLightingLab(devPanels, {
        setExperiment: (settings) => scene?.setLightingExperiment(settings),
        enabled: preferences.developerMode,
        initial: preferences.lighting,
        onChange: (settings) => {
          preferences.lighting = settings;
          savePrefs();
        },
        onClose: () => closeDebugPanel("developerMode"),
      });
    }
    await Promise.all([
      scene.load(),
      document.fonts.load("400 20px MiSans"),
      document.fonts.load("600 20px MiSans"),
    ]);
    ready = true;
    $<HTMLButtonElement>('[data-action="overview"]').disabled = false;
    $("#three-scene canvas").setAttribute(
      "aria-label",
      `三维专辑阵列，左右切${sortLabel.column}，上下切专辑`,
    );
    stage.classList.toggle("reduce-motion", preferences.reduced);
    await scene.refreshLibrary(selected);
    scene.setTheme(preferences.theme);
    scene.setQuality(renderQuality);
    scene.setReduced(preferences.reduced);
    scene.setGlassFrost(preferences.glassFrost);
    scene.setSharpen(preferences.sharpen);
    scene.setMusicArrayMode(preferences.arrayMode);
    scene.onSelect = (index, cell) => {
      if (!boot?.active && presentation.phase === "archive" && !panel) {
        select(index, cell ? { cell } : undefined);
        if (overview) setOverview(false);
      }
    };
    scene.onNavigate = (axis, direction) => {
      if (!boot?.active && presentation.phase === "archive" && !panel)
        axis === "lane" ? stepGenre(direction) : stepAlbum(direction);
    };
    mountMusicWheelNavigation(stage, {
      enabled: () => ready && !boot?.active && presentation.phase === "archive" && !panel &&
        columnFiles(fileLocation(navigationSelection()).lane).length > 1,
      navigate: stepAlbum,
      context: () => fileLocation(navigationSelection()).lane,
    });
    $("#music-loading").remove();
    updateSelection();
    if (albums.length && new URLSearchParams(location.search).get("scene") !== "archive") {
      boot?.start(performance.now() / 1000);
    } else {
      scene.showMusicArchiveImmediately(performance.now() / 1000);
      effects.setScene("archive");
      if (albums.length) showBrowseSurface();
      else browseTransition.hide(true);
      $("#music-browse").inert = !albums.length;
      $("#music-browse").setAttribute("aria-hidden", String(!albums.length));
    }
    syncSelectionMotion();
    requestAnimationFrame((ms) => {
      stage.classList.add("theme-motion-ready");
      frame(ms);
    });
  } catch (error) {
    console.error(error);
    $("#music-loading").innerHTML =
      `<strong>三维资源未能加载</strong><small>${esc((error as Error).message)}</small><button data-action="library">检查音乐库</button>`;
  }
}
void start();
Object.assign(window, {
  rhineMusic: {
    get library() {
      return library;
    },
    get selectedAlbum() {
      return currentAlbum();
    },
    get player() {
      return player.state;
    },
    stats: () => scene?.getStats(),
    /** Live state of the detail/lyrics switch, for on-device verification. */
    get detailSwitch() {
      return {
        state: detailSwitch.open ? "lyrics" : "detail",
        progress: Number(detailSwitch.dragProgress.toFixed(3)),
        locked: detailSwitch.locked,
        lyricsTrack: lyricsPane.trackId,
        lyricsPrepared: lyricsPane.prepared,
      };
    },
    get presentation() {
      return { phase: presentation.phase, cameraPhase: scene?.musicPresentationPhase,
        pendingIndex: presentation.pendingSelection?.index,
        menuVisible: !$("#music-detail").hidden,
        cameraReady: scene?.musicPresentationReady,
        archiveReady: scene?.musicArchiveReady };
    },
  },
});
