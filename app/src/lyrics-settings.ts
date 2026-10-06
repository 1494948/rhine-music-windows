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

const slider = (settings: LyricsSettings, row: Row) =>
  `<label class="settings-row"><span>${row.label}<small>${row.hint}</small></span>` +
  `<span class="settings-slider"><input type="range" data-lyric="${row.key}" aria-label="${row.label}" ` +
  `min="${row.min}" max="${row.max}" step="${row.step}" value="${settings[row.key]}">` +
  `<output data-lyric-output="${row.key}">${row.format(settings[row.key])}</output></span></label>`;

const swatch = (settings: LyricsSettings, key: "color" | "accent", label: string, hint: string) =>
  `<label class="settings-row"><span>${label}<small>${hint}</small></span>` +
  `<span class="lyric-swatches"><input type="color" data-lyric-color="${key}" aria-label="${label}" ` +
  `value="${settings[key] || "#000000"}">` +
  `<button type="button" class="text-button" data-action="lyric-color-reset" data-lyric-key="${key}" ` +
  `${settings[key] ? "" : "disabled"}>跟随主题</button></span></label>`;

/**
 * A live sample of the lyric surface. It carries the same token names and the
 * same `data-d` tiers as the real pane, so what is shown here is what the pane
 * renders — no second implementation to keep in sync.
 */
function preview() {
  const fill = (index: number, text: string, p: number, blur: string, tier: string) =>
    `<div class="lyric-line" data-d="${tier}" style="--i:${index};--blur:${blur}">` +
    `<span class="lyric-main">${escape(text)}</span>` +
    `<span class="lyric-fill" aria-hidden="true" style="--p:${p}">${escape(text)}</span></div>`;
  return `<div class="lyric-preview" id="lyric-preview" aria-label="歌词效果预览">
    <div class="lyric-preview-stage">
      ${fill(0, "我想将我的寂寞封闭", 1, "blur(1.4px)", "near")}
      ${fill(1, "然后在这里 不限日期", 0.46, "none", "0")}
      ${fill(2, "然后将过去 慢慢温习", 0, "blur(1.4px)", "near")}
    </div></div>`;
}

export function lyricsMarkup(settings: LyricsSettings) {
  return `<section class="panel-section" id="lyric-settings"><h3>歌词</h3>
    <p>调整歌词的字号、颜色与动效。所有改动即时生效并自动保存，下面的预览与播放页用的是同一套样式。</p>
    ${preview()}
    ${swatch(settings, "accent", "高亮颜色", "正在演唱的逐字填充色；未选择时跟随主题强调色")}
    ${swatch(settings, "color", "歌词颜色", "非高亮行的文字颜色；未选择时跟随主题正文色")}
    ${rows.map((row) => slider(settings, row)).join("")}
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
