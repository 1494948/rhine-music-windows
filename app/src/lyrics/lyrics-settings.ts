/**
 * 「歌词」 settings module.
 *
 * The lyric pane is driven entirely by CSS custom properties on its own element,
 * so this module owns the single token list that both the real pane
 * (`LyricsPane.setStyle`) and the in-panel preview write. Keeping one list means
 * the preview cannot drift from the pane.
 *
 * Two values cannot live in CSS alone and are read back by the pane:
 *   - `pitch` is also the scroll target, so the renderer needs the number;
 *   - `delayMs` is folded into the playback clock.
 * They are plain properties on the settings object for that reason.
 */

import { splitChars, splitUnits, type LyricsUnit } from "./music-lyrics.ts";

export interface LyricsSettings {
  /** Singing-line font size, px. */
  size: number;
  /** Row pitch, px. */
  pitch: number;
  /** Idle-line size as a fraction of the singing line. */
  idleSize: number;
  /** Idle-line colour; empty string means "follow the theme". */
  color: string;
  /** Karaoke fill colour; empty string means "follow the theme". */
  accent: string;
  /** Sweep feather, in multiples of the font size (AMLL's `wordFadeWidth`). */
  fade: number;
  /** Strength of the un-sung part of the singing line. */
  unsung: number;
  /** Blur multiplier across the distance tiers. */
  blur: number;
  /** Global brightness multiplier for the idle tiers. */
  dim: number;
  /** Glow around the singing line, 0–1. */
  glow: number;
  /** Idle float amplitude of the singing line, px. */
  float: number;
  /** Idle float period, seconds. */
  floatPeriod: number;
  /** How far an unsung unit sits below its resting place, px. */
  unitLift: number;
  /** How much larger an unsung unit is than a sung one, as a ratio. */
  unitPop: number;
  /** Resting offset of a line that is still on approach, px. */
  enter: number;
  /** Emphasis scale on the singing line. */
  activeScale: number;
  /** Overshoot the singing line lands with, as a scale delta. */
  settle: number;
  /** Breathing period of the interlude dots, seconds. */
  dotPeriod: number;
  /** Gap in seconds that counts as an interlude; 0 disables the dots. */
  interludeGap: number;
  /** Lyric offset against the audio clock in ms; positive makes lyrics lead. */
  delayMs: number;
}

export const LYRICS_STORAGE_KEY = "rhine-lyric-preferences";

/** The shipped look. Mirrors the fallbacks declared in music-lyrics-switch.css. */
export const defaultLyricsSettings: LyricsSettings = {
  size: 17,
  pitch: 52,
  idleSize: 0.92,
  color: "",
  accent: "",
  fade: 0.5,
  unsung: 0.62,
  blur: 1,
  dim: 1,
  glow: 0.45,
  float: 3,
  floatPeriod: 5.4,
  unitLift: 4,
  unitPop: 0.03,
  enter: 6,
  activeScale: 1.035,
  settle: 0.05,
  dotPeriod: 2.4,
  interludeGap: 6,
  delayMs: 0,
};

type NumericKey = Exclude<keyof LyricsSettings, "color" | "accent">;

interface Row {
  key: NumericKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  /** Renders the live readout next to the slider. */
  format: (value: number) => string;
}

const rows: Row[] = [
  {
    key: "size",
    label: "歌词字号",
    hint: "高亮行的大小；其余行按下面的比例缩小",
    min: 12,
    max: 32,
    step: 1,
    format: (v) => `${v}px`,
  },
  {
    key: "pitch",
    label: "行距",
    hint: "每行占据的高度，影响同屏可见行数与滚动幅度",
    min: 34,
    max: 84,
    step: 2,
    format: (v) => `${v}px`,
  },
  {
    key: "idleSize",
    label: "非高亮行缩放",
    hint: "越小，前后文的纵深越强（AMLL 的 bg-line-scale 约为 0.7，这里默认 0.92）",
    min: 0.78,
    max: 1,
    step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: "fade",
    label: "逐字渐变宽度",
    hint: "扫过时的柔边宽度，以字号为单位；0.5 接近 iPad 版 Apple Music，1 接近 Android 版",
    min: 0.05,
    max: 2,
    step: 0.05,
    format: (v) => `${v.toFixed(2)} 字`,
  },
  {
    key: "unsung",
    label: "未唱部分浓度",
    hint: "高亮行里还没唱到的部分有多亮；越低，扫过的对比越强",
    min: 0.2,
    max: 1,
    step: 0.02,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: "glow",
    label: "高亮行辉光",
    hint: "围绕正在演唱那一行的柔光；0 关闭",
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => (v === 0 ? "关闭" : `${Math.round(v * 100)}%`),
  },
  {
    key: "float",
    label: "浮动幅度",
    hint: "高亮行缓慢上下的距离；0 关闭",
    min: 0,
    max: 8,
    step: 0.5,
    format: (v) => (v === 0 ? "关闭" : `${v}px`),
  },
  {
    key: "floatPeriod",
    label: "浮动周期",
    hint: "一次上下往返的秒数；越长越慢越安静",
    min: 2.4,
    max: 12,
    step: 0.2,
    format: (v) => `${v.toFixed(1)}s`,
  },
  {
    key: "unitLift",
    label: "逐字上浮",
    hint: "还没唱到的字停在下方的距离，唱到时落回原位；0 关闭逐字位移",
    min: 0,
    max: 12,
    step: 0.5,
    format: (v) => (v === 0 ? "关闭" : `${v}px`),
  },
  {
    key: "unitPop",
    label: "逐字呼吸",
    hint: "还没唱到的字比唱过的略大多少；0 关闭",
    min: 0,
    max: 0.12,
    step: 0.005,
    format: (v) => (v === 0 ? "关闭" : `${(v * 100).toFixed(1)}%`),
  },
  {
    key: "enter",
    label: "行进入位移",
    hint: "未轮到的行停留在下方的距离，越近越小；0 时各行完全静止",
    min: 0,
    max: 20,
    step: 1,
    format: (v) => (v === 0 ? "关闭" : `${v}px`),
  },
  {
    key: "activeScale",
    label: "高亮行放大",
    hint: "正在演唱那一行相对其他行的放大倍数；100% 表示不放大",
    min: 1,
    max: 1.14,
    step: 0.005,
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: "settle",
    label: "接手过冲",
    hint: "高亮行接手时的回弹幅度；只作用在接上的那一瞬，0 关闭",
    min: 0,
    max: 0.14,
    step: 0.005,
    format: (v) => (v === 0 ? "关闭" : `±${(v * 100).toFixed(1)}%`),
  },
  {
    key: "interludeGap",
    label: "间奏律动触发",
    hint: "一句唱完、下一句还差这么多秒时显示呼吸点；0 关闭",
    min: 0,
    max: 16,
    step: 0.5,
    format: (v) => (v === 0 ? "关闭" : `${v.toFixed(1)}s`),
  },
  {
    key: "dotPeriod",
    label: "律动周期",
    hint: "呼吸点一次起伏的秒数；越长越安静",
    min: 1.2,
    max: 4.8,
    step: 0.2,
    format: (v) => `${v.toFixed(1)}s`,
  },
  {
    key: "blur",
    label: "虚化强度",
    hint: "离高亮行越远越模糊；0 关闭全部虚化（最清晰也最省）",
    min: 0,
    max: 1.5,
    step: 0.1,
    format: (v) => (v === 0 ? "关闭" : `${v.toFixed(1)}×`),
  },
  {
    key: "dim",
    label: "整体明暗",
    hint: "统一调整非高亮行的亮度，不改高亮行",
    min: 0.5,
    max: 1.4,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: "delayMs",
    label: "歌词偏移",
    hint: "正值歌词提前，负值歌词延后；用于对齐个别歌词文件的时间轴",
    min: -800,
    max: 800,
    step: 20,
    format: (v) => (v === 0 ? "0ms" : `${v > 0 ? "+" : ""}${v}ms`),
  },
];

const numericKeys = rows.map((row) => row.key);

/**
 * The four sections the controls are presented in. `groupOf` is the single
 * source of truth for where a control lives, so the markup can render groups
 * without duplicating the row definitions.
 */
const groupOrder = [
  { id: "layout", title: "字号与版式" },
  { id: "color", title: "颜色与高亮" },
  { id: "motion", title: "动效" },
  { id: "time", title: "时间" },
] as const;

type GroupId = (typeof groupOrder)[number]["id"];

const groupOf: Record<NumericKey | "color" | "accent", GroupId> = {
  size: "layout",
  pitch: "layout",
  idleSize: "layout",
  activeScale: "layout",
  color: "color",
  accent: "color",
  fade: "color",
  unsung: "color",
  glow: "color",
  dim: "color",
  blur: "color",
  unitLift: "motion",
  unitPop: "motion",
  enter: "motion",
  settle: "motion",
  float: "motion",
  floatPeriod: "motion",
  dotPeriod: "motion",
  interludeGap: "time",
  delayMs: "time",
};

/** Keys a group's reset restores to their defaults, in display order. */
export function lyricGroupKeys(id: string): (NumericKey | "color" | "accent")[] {
  return [
    ...rows.filter((row) => groupOf[row.key] === id).map((row) => row.key),
    ...(["color", "accent"] as const).filter((key) => groupOf[key] === id),
  ];
}

/** The preset patch for `id`, or an empty one if the id is unknown. */
export function lyricPresetPatch(id: string): Partial<LyricsSettings> {
  return lyricPresets.find((preset) => preset.id === id)?.patch ?? {};
}

/**
 * Applies a partial patch and clamps the result the way loading from storage
 * does, so a preset, a group reset or an import can never store an out-of-range
 * value. Returns the merged settings (a fresh object).
 */
export function applyLyricPatch(
  settings: LyricsSettings,
  patch: Partial<LyricsSettings>,
): LyricsSettings {
  return normalize({ ...settings, ...patch });
}

/**
 * Three starting points. Each is a partial patch over the defaults, so applying
 * one can never leave a field unset — a missing key simply keeps the shipped
 * default.
 */
export interface LyricPreset {
  id: string;
  label: string;
  hint: string;
  patch: Partial<LyricsSettings>;
}

export const lyricPresets: LyricPreset[] = [
  {
    id: "subtle",
    label: "克制",
    hint: "接近现状的轻量动效",
    patch: {},
  },
  {
    id: "apple",
    label: "Apple Music",
    hint: "更大字号、轻微上浮、更柔和的边缘",
    patch: {
      size: 24,
      pitch: 62,
      idleSize: 0.82,
      fade: 0.5,
      float: 2,
      floatPeriod: 6,
      unitLift: 2,
      unitPop: 0,
      enter: 3,
      activeScale: 1.02,
      settle: 0.03,
      glow: 0.2,
    },
  },
  {
    id: "amll",
    label: "AMLL",
    hint: "逐字起伏明显、行间有呼吸感",
    patch: {
      size: 20,
      pitch: 58,
      idleSize: 0.7,
      fade: 0.55,
      unitLift: 7,
      unitPop: 0.06,
      enter: 10,
      activeScale: 1.08,
      settle: 0.09,
      float: 4,
      floatPeriod: 4.6,
    },
  },
];

/** Clamp and repair whatever was in local storage. */
function normalize(raw: unknown): LyricsSettings {
  const source = (raw ?? {}) as Partial<LyricsSettings>;
  const out = { ...defaultLyricsSettings };
  for (const row of rows) {
    const value = Number(source[row.key]);
    out[row.key] = Number.isFinite(value)
      ? Math.min(row.max, Math.max(row.min, value))
      : defaultLyricsSettings[row.key];
  }
  for (const key of ["color", "accent"] as const) {
    const value = source[key];
    out[key] = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "";
  }
  return out;
}

export function loadLyricsSettings(): LyricsSettings {
  try {
    return normalize(JSON.parse(localStorage.getItem(LYRICS_STORAGE_KEY) || "null"));
  } catch {
    return { ...defaultLyricsSettings };
  }
}

export function saveLyricsSettings(settings: LyricsSettings) {
  try {
    localStorage.setItem(LYRICS_STORAGE_KEY, JSON.stringify(settings));
  } catch {}
}

/** `#rrggbb` (or a resolved theme colour) at a given alpha, as an rgba() string. */
function rgba(color: string, alpha: number) {
  const hex = color.trim().replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
  const value = Number.parseInt(full, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha.toFixed(3)})`;
}

/**
 * The one place the token set is defined.
 *
 * `host` is only needed to resolve the glow colour when the user has not picked
 * an accent: the glow has to be a concrete colour, and the theme's accent is a
 * CSS variable that only a computed style can resolve.
 */
export function lyricTokenList(
  settings: LyricsSettings,
  host?: HTMLElement,
): Record<string, string> {
  const accent =
    settings.accent ||
    (host
      ? getComputedStyle(host).getPropertyValue("--accent").trim()
      : "") ||
    "#b56834";
  const tokens: Record<string, string> = {
    "--ly-size": `${settings.size}px`,
    // `--line-h` positions every line and `--ly-pitch` is its readable alias;
    // both are written so either consumer stays correct.
    "--line-h": `${settings.pitch}px`,
    "--ly-pitch": `${settings.pitch}px`,
    "--ly-idle-size": settings.idleSize.toFixed(3),
    "--ly-fade": settings.fade.toFixed(3),
    "--ly-unsung": settings.unsung.toFixed(3),
    "--ly-dim": settings.dim.toFixed(3),
    "--ly-float": `${settings.float}px`,
    "--ly-float-period": `${settings.floatPeriod}s`,
    "--ly-unit-lift": `${settings.unitLift}px`,
    "--ly-unit-pop": settings.unitPop.toFixed(4),
    "--ly-enter": `${settings.enter}px`,
    "--ly-active-scale": settings.activeScale.toFixed(4),
    "--ly-settle": settings.settle.toFixed(4),
    "--ly-dot-period": `${settings.dotPeriod}s`,
    "--ly-glow-size": `${Math.round(settings.glow * 16)}px`,
    "--ly-glow-color": settings.glow > 0 ? rgba(accent, settings.glow * 0.5) : "transparent",
  };
  // An empty colour means "follow the theme", which is exactly what the
  // stylesheet fallback (`var(--ink)` / `var(--accent)`) already does, so the
  // property is left unset rather than pinned to whatever the theme was today.
  if (settings.color) tokens["--ly-color"] = settings.color;
  if (settings.accent) tokens["--ly-accent"] = settings.accent;
  return tokens;
}

export function applyLyricTokens(host: HTMLElement, settings: LyricsSettings) {
  for (const [name, value] of Object.entries(lyricTokenList(settings, host)))
    host.style.setProperty(name, value);
}

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const swatch = (settings: LyricsSettings, key: "color" | "accent", label: string, hint: string) =>
  `<label class="settings-row"><span>${label}<small>${hint}</small></span>` +
  `<span class="lyric-swatches"><input type="color" data-lyric-color="${key}" aria-label="${label}" ` +
  `value="${settings[key] || "#000000"}">` +
  `<button type="button" class="text-button" data-action="lyric-color-reset" data-lyric-key="${key}" ` +
  `${settings[key] ? "" : "disabled"}>跟随主题</button></span></label>`;

/**
 * A live sample of the lyric surface. It carries the same token names, the same
 * `data-d` tiers and the same per-unit spans as the real pane, so what is shown
 * here is what the pane renders — no second implementation to keep in sync.
 */

export interface LyricPreviewTrack {
  id: string;
  title: string;
  artist: string;
}

/** A frozen sweep: the `p * n`-th unit is mid-fill, the ones before it sung. */
function sampleReveal(units: LyricsUnit[], p: number): number[] {
  return units.map((_, index) => Math.max(0, Math.min(1, p * units.length - index)));
}

/** Three stacked lines — the chosen one active, its neighbours dimmed. */
function lyricPreviewSample(activeText: string, p: number, prevText: string, nextText: string) {
  const units = splitUnits(splitChars(activeText || " "));
  const reveal = sampleReveal(units, p);
  const spans = units
    .map((unit, index) => `<span class="lyric-unit" style="--g:${reveal[index].toFixed(2)}">${escape(unit.text)}</span>`)
    .join("");
  const idle = (index: number, text: string) =>
    `<div class="lyric-line" data-d="near" style="--i:${index};--blur:blur(1.4px)">` +
    `<span class="lyric-main">${escape(text)}</span>` +
    `<span class="lyric-fill" aria-hidden="true" style="--p:0">${escape(text)}</span></div>`;
  const active =
    `<div class="lyric-line" data-d="0" style="--i:1;--blur:none">` +
    `<span class="lyric-main"><span class="lyric-units">${spans}</span></span>` +
    `<span class="lyric-fill" aria-hidden="true" style="--p:${p.toFixed(2)}">` +
    `<span class="lyric-units">${spans}</span></span></div>`;
  return idle(0, prevText || "　") + active + idle(2, nextText || "　");
}

export function lyricPreviewMarkup(tracks: LyricPreviewTrack[] = []) {
  const options = tracks
    .map(
      (track) =>
        `<option value="${escape(track.id)}">${escape(track.title)}` +
        `${track.artist ? ` · ${escape(track.artist)}` : ""}</option>`,
    )
    .join("");
  return `<div class="lyric-preview" id="lyric-preview" aria-label="歌词效果预览">
    <div class="lyric-preview-bar">
      <select id="lyric-preview-track" data-lyric-preview="track" aria-label="预览歌曲"${tracks.length ? "" : " disabled"}>${
        tracks.length ? options : `<option value="">当前专辑没有可预览的曲目</option>`
      }</select>
      <select id="lyric-preview-line" data-lyric-preview="line" aria-label="预览行"><option value="0">第 1 句</option></select>
      <label class="lyric-preview-follow"><input type="checkbox" data-lyric-preview="follow">跟随播放</label>
    </div>
    <div class="lyric-preview-stage" id="lyric-preview-stage">${lyricPreviewSample(
      "在预览里选一句歌词，看逐字动效。",
      0.46,
      "",
      "",
    )}</div>
  </div>`;
}

/** Replaces the sample lines; tokens inherit from `#lyric-preview`, so nothing else moves. */
export function setLyricPreviewSample(activeText: string, p: number, prevText = "", nextText = "") {
  const stage = document.getElementById("lyric-preview-stage");
  if (stage) stage.innerHTML = lyricPreviewSample(activeText, p, prevText, nextText);
}

/** Rewrites the line picker after a track's lyric document is known. */
export function setLyricPreviewLineCount(count: number) {
  const select = document.querySelector<HTMLSelectElement>("#lyric-preview-line");
  if (!select) return;
  const current = Number(select.value);
  const total = Math.max(1, count);
  select.innerHTML = Array.from({ length: total }, (_, index) =>
    `<option value="${index}">第 ${index + 1} 句</option>`,
  ).join("");
  select.value = String(Math.min(current, total - 1));
  select.disabled = count === 0;
}

export function lyricsMarkup(settings: LyricsSettings, tracks: LyricPreviewTrack[] = []) {
  const sliderRow = (row: Row) =>
    `<label class="settings-row"><span>${row.label}<small>${row.hint}</small></span>` +
    `<span class="settings-slider"><input type="range" data-lyric="${row.key}" aria-label="${row.label}" ` +
    `min="${row.min}" max="${row.max}" step="${row.step}" value="${settings[row.key]}">` +
    `<output data-lyric-output="${row.key}">${row.format(settings[row.key])}</output>` +
    `<button type="button" class="lyric-reset-one" data-action="lyric-row-reset" data-lyric-row="${row.key}" aria-label="复位${row.label}" title="恢复默认">↺</button></span></label>`;
  const groups = groupOrder
    .map((group) => {
      const rowsInGroup = rows.filter((row) => groupOf[row.key] === group.id);
      const swatchesInGroup = (["color", "accent"] as const).filter((key) => groupOf[key] === group.id);
      const body =
        (swatchesInGroup.includes("accent")
          ? swatch(settings, "accent", "高亮颜色", "正在演唱的逐字填充色；未选择时跟随主题强调色")
          : "") +
        (swatchesInGroup.includes("color")
          ? swatch(settings, "color", "歌词颜色", "非高亮行的文字颜色；未选择时跟随主题正文色")
          : "") +
        rowsInGroup.map(sliderRow).join("");
      return `<div class="lyric-group" data-lyric-group="${group.id}"><h4>${group.title}` +
        `<button type="button" class="text-button" data-action="lyric-group-reset" data-lyric-group="${group.id}">复位本组</button></h4>${body}</div>`;
    })
    .join("");
  return `<section class="panel-section" id="lyric-settings"><h3>歌词</h3>
    <p>调整歌词的字号、颜色与动效。所有改动即时生效并自动保存，下面的预览与播放页用的是同一套样式。</p>
    ${lyricPreviewMarkup(tracks)}
    <div class="lyric-presets" role="group" aria-label="歌词预设">${lyricPresets
      .map(
        (preset) =>
          `<button type="button" class="lyric-preset" data-action="lyric-preset" data-preset="${preset.id}" aria-pressed="false">` +
          `<strong>${preset.label}</strong><small>${preset.hint}</small></button>`,
      )
      .join("")}</div>
    ${groups}
    <details class="lyric-transfer"><summary>导入 / 导出参数</summary>
      <p>导出会复制一段 JSON；把它发给别人或存下来，之后粘贴到下面点「应用」即可恢复。</p>
      <textarea id="lyric-json" class="json-editor" spellcheck="false" placeholder='粘贴歌词参数的 JSON …'></textarea>
      <div class="panel-actions"><button type="button" data-action="lyric-import" class="primary-button">应用 JSON</button><button type="button" data-action="lyric-export">复制 JSON</button></div>
      <p id="lyric-transfer-status" class="scan-status" role="status"></p>
    </details>
    <p class="lyric-settings-foot"><button class="text-button" data-action="lyric-reset">恢复默认参数 ↺</button></p>
  </section>`;
}

/** Re-anchor every control after a programmatic change (e.g. reset). */
export function syncLyricsUI(settings: LyricsSettings) {
  document.querySelectorAll<HTMLInputElement>("[data-lyric]").forEach((control) => {
    const key = control.dataset.lyric as NumericKey;
    control.value = String(settings[key]);
  });
  document
    .querySelectorAll<HTMLOutputElement>("[data-lyric-output]")
    .forEach((output) => {
      const key = output.dataset.lyricOutput as NumericKey;
      const row = rows.find((entry) => entry.key === key);
      if (row) output.value = row.format(settings[key]);
    });
  document.querySelectorAll<HTMLInputElement>("[data-lyric-color]").forEach((control) => {
    const key = control.dataset.lyricColor as "color" | "accent";
    control.value = settings[key] || "#000000";
  });
  document
    .querySelectorAll<HTMLButtonElement>('[data-action="lyric-color-reset"]')
    .forEach((button) => {
      const key = button.dataset.lyricKey as "color" | "accent";
      button.disabled = !settings[key];
    });
  const host = document.getElementById("lyric-preview");
  if (host) {
    applyLyricTokens(host, settings);
    // The preview sits on the panel surface, not inside the themed pane, so the
    // theme colours it depends on are inherited on demand.
    const pane = document.getElementById("music-lyrics-pane");
    if (pane) {
      const resolved = getComputedStyle(pane);
      for (const name of ["--ink", "--accent", "--line"]) {
        const value = resolved.getPropertyValue(name).trim();
        if (value) host.style.setProperty(name, value);
      }
    }
  }
}

/** Read one control back into the settings object; returns true when it applied. */
export function applyLyricControl(target: HTMLInputElement, settings: LyricsSettings) {
  const numeric = target.dataset.lyric as NumericKey | undefined;
  if (numeric && numericKeys.includes(numeric)) {
    const row = rows.find((entry) => entry.key === numeric)!;
    const value = Number(target.value);
    settings[numeric] = Number.isFinite(value)
      ? Math.min(row.max, Math.max(row.min, value))
      : settings[numeric];
    const output = document.querySelector<HTMLOutputElement>(`[data-lyric-output="${numeric}"]`);
    if (output) output.value = row.format(settings[numeric]);
    return true;
  }
  const color = target.dataset.lyricColor as "color" | "accent" | undefined;
  if (color === "color" || color === "accent") {
    settings[color] = target.value.toLowerCase();
    const reset = document.querySelector<HTMLButtonElement>(
      `[data-action="lyric-color-reset"][data-lyric-key="${color}"]`,
    );
    if (reset) reset.disabled = false;
    return true;
  }
  return false;
}
