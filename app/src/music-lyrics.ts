/**
 * Lyrics parsing, kept free of DOM and of any import so it stays unit testable
 * through `node --experimental-strip-types` and cheap to load.
 *
 * Three shapes are accepted, because three shapes reach the player in practice:
 *
 * 1. LRC text — `[00:12.34]一句歌词`, optionally with several timestamps on one
 *    line and with an `[offset:±ms]` correction. The same syntax carries
 *    per-character timings as `<00:12.34>` inline tags (enhanced LRC), which is
 *    what karaoke-capable local libraries ship.
 * 2. ID3v2 SYLT — already a list of `{ text, timestamp }` pairs in milliseconds.
 * 3. ID3v2 USLT or a plain .txt — unsynced reading text, one lyric per line.
 *
 * Anything the player cannot read stays out of the interface: the pane is only
 * ever built after a document with at least one line has been produced here.
 */

export type LyricsSource = "lrc" | "sylt" | "uslt" | "plain" | "none";

/** A single timed character. `time` is always in seconds. */
export interface LyricsChar {
  time: number;
  char: string;
}

export interface LyricsLine {
  /** Seconds. Never negative inside a synced document. */
  time: number;
  text: string;
  /** Per-character timings taken from enhanced LRC, or empty. */
  chars: LyricsChar[];
}

export interface LyricsDocument {
  source: LyricsSource;
  /** Seconds taken from `[offset:±ms]`; added to every timestamp already. */
  offset: number;
  /** False for USLT / plain text, where lines have no meaningful time. */
  synced: boolean;
  lines: LyricsLine[];
}

/** The payload `GET /api/lyrics/:trackId` returns. */
export interface LyricsPayload {
  source?: string;
  text?: string;
  sync?: { text?: string; timestamp?: number }[];
}

export const EMPTY_LYRICS: LyricsDocument = {
  source: "none",
  offset: 0,
  synced: false,
  lines: [],
};

// A leading run of timestamps, then the lyric text. Several tags may precede
// one line, and both `mm:ss.xx` and the rarer `mm:ss:xx` separators appear.
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i;
// Descriptive tags that carry no lyric text. `offset` is consumed separately.
const META_TAG = /^\[(ti|ar|al|au|by|re|ve|length|kana|kuwo|hash|total|sign|qq|id):[^\]]*\]$/i;

/** `mm:ss.xx` / `mm:ss:xx` / `mm:ss` → seconds. Fractions are right-padded. */
function toSeconds(minutes: string, seconds: string, fraction?: string) {
  const frac = fraction ? Number(`0.${fraction.padEnd(3, "0").slice(0, 3)}`) : 0;
  return Number(minutes) * 60 + Number(seconds) + frac;
}

function emptyDocument(source: LyricsSource): LyricsDocument {
  return { source, offset: 0, synced: false, lines: [] };
}

/**
 * Splits a lyric body into plain lines, dropping the timestamp-only lines that
 * mark instrumental stretches. Their times still bound the previous line, so
 * the returned list keeps only what can be read.
 */
function splitLines(body: string) {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim().length > 0);
}

/** Timestamps in a line, plus the lyric text with every tag removed. */
function readTimedLine(line: string) {
  const times: number[] = [];
  TIME_TAG.lastIndex = 0;
  for (let match = TIME_TAG.exec(line); match; match = TIME_TAG.exec(line)) {
    times.push(toSeconds(match[1], match[2], match[3]));
  }
  const rest = line.replace(TIME_TAG, "");
  // Walk the word tags, keeping the untimed runs between them in order.
  const runs: LyricsChar[] = [];
  let tagged = false;
  let cursor = 0;
  WORD_TAG.lastIndex = 0;
  for (let match = WORD_TAG.exec(rest); match; match = WORD_TAG.exec(rest)) {
    tagged = true;
    const before = rest.slice(cursor, match.index);
    if (before) runs.push({ time: -1, char: before });
    runs.push({ time: toSeconds(match[1], match[2], match[3]), char: "" });
    cursor = match.index + match[0].length;
  }
  const tail = rest.slice(cursor);
  if (tail) runs.push({ time: -1, char: tail });
  /**
   * `<t>词` marks the start of the text behind it, so each timing is handed to
   * the run that follows. A run with no tag before it inherits the line's own
   * start, which is what keeps a partially tagged file usable. A file with no
   * word tags at all keeps `-1` throughout, so the pane spreads the line itself
   * instead of lighting every glyph at the same instant.
   */
  const fallback = tagged && times.length ? times[0] : -1;
  const chars: LyricsChar[] = [];
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    const next = runs[index + 1];
    if (run.time >= 0 && next && next.time < 0 && next.char) {
      for (const glyph of next.char) chars.push({ time: run.time, char: glyph });
      index++;
      continue;
    }
    if (run.time >= 0) continue;
    for (const glyph of run.char) chars.push({ time: fallback, char: glyph });
  }
  return {
    times,
    text: rest.replace(WORD_TAG, "").trim(),
    chars: chars.filter((entry) => entry.char.length > 0),
  };
}

/**
 * Parses LRC, including the enhanced (per-character) variant. Multiple
 * timestamps on one line duplicate it, which is what karaoke files mean by
 * `[00:01.00][00:05.00]同一句`.
 */
export function parseLrc(text: string): LyricsDocument {
  const document = emptyDocument("lrc");
  const offsetMatch = OFFSET_TAG.exec(text);
  if (offsetMatch) document.offset = Number(offsetMatch[1]) / 1000;
  const collected: LyricsLine[] = [];
  for (const raw of splitLines(text)) {
    let line = raw;
    if (OFFSET_TAG.test(line)) line = line.replace(OFFSET_TAG, "");
    if (!line.trim() || META_TAG.test(line.trim())) continue;
    const { times, text: body, chars } = readTimedLine(line);
    if (!times.length) continue;
    if (!body) continue;
    for (const time of times) {
      collected.push({ time, text: body, chars: chars.map((entry) => ({ ...entry })) });
    }
  }
  if (!collected.length) return document;
  collected.sort((a, b) => a.time - b.time);
  // Two tags landing on the same instant would otherwise double-draw a line.
  const lines: LyricsLine[] = [];
  for (const line of collected) {
    const previous = lines.at(-1);
    if (previous && Math.abs(previous.time - line.time) < 0.001) {
      previous.text = line.text;
      previous.chars = line.chars;
      continue;
    }
    lines.push(line);
  }
  for (const line of lines) line.time += document.offset;
  document.lines = lines.filter((line) => line.time >= 0);
  if (!document.lines.length) document.lines = lines;
  document.synced = true;
  return document;
}

/** ID3v2 SYLT: millisecond timestamps that arrive already in order. */
export function parseSyncedText(
  items: { text?: string; timestamp?: number }[],
): LyricsDocument {
  const document = emptyDocument("sylt");
  const lines: LyricsLine[] = [];
  for (const item of items) {
    const body = (item.text ?? "").replace(/\s+$/, "");
    if (!body.trim()) continue;
    const time = Number(item.timestamp);
    if (!Number.isFinite(time) || time < 0) continue;
    lines.push({ time: time / 1000, text: body.trim(), chars: [] });
  }
  if (!lines.length) return document;
  lines.sort((a, b) => a.time - b.time);
  document.lines = lines;
  document.synced = true;
  return document;
}

/** USLT or a plain text file: readable, but every line shares no timing. */
export function parsePlainText(text: string): LyricsDocument {
  const document = emptyDocument("plain");
  const lines = splitLines(text).map((line) => ({
    time: -1,
    text: line.trim(),
    chars: [] as LyricsChar[],
  }));
  const seen = new Set<string>();
  document.lines = lines.filter((line) => {
    if (seen.has(line.text)) return false;
    seen.add(line.text);
    return true;
  });
  return document;
}

/**
 * Single entry point for whatever the local service returned. LRC detection
 * runs first because a synced payload is also valid plain text, and a synced
 * reading is strictly more useful than an unsynced one.
 */
export function parseLyricsPayload(payload: LyricsPayload | undefined | null): LyricsDocument {
  if (!payload) return EMPTY_LYRICS;
  const source = (payload.source ?? "").toLowerCase();
  if (Array.isArray(payload.sync) && payload.sync.length) {
    const synced = parseSyncedText(payload.sync);
    if (synced.lines.length) return synced;
  }
  const text = payload.text ?? "";
  if (text.includes("[")) {
    const lrc = parseLrc(text);
    if (lrc.lines.length) return lrc;
  }
  if (text.trim()) return parsePlainText(text);
  if (source === "none") return EMPTY_LYRICS;
  return EMPTY_LYRICS;
}

/** Index of the line that should be highlighted at `time`, or -1 before start. */
export function findActiveLine(document: LyricsDocument, time: number) {
  const { lines } = document;
  if (!document.synced || !lines.length) return -1;
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].time <= time) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** Time at which `index` stops being the active line; never earlier than it. */
export function lineEndTime(document: LyricsDocument, index: number) {
  const line = document.lines[index];
  if (!line) return 0;
  const next = document.lines[index + 1];
  // Instrumental gaps would hold one line on screen for a minute or more, so
  // the karaoke sweep is capped and the line simply finishes early.
  return next ? Math.max(line.time + 0.2, Math.min(next.time, line.time + 12)) : line.time + 6;
}

/**
 * Per-character timings for one line. Enhanced LRC already has them; everything
 * else spreads the line evenly, which is what a karaoke sweep needs and what
 * most LRC files implicitly assume.
 */
export function charTimeline(document: LyricsDocument, index: number, chars: string[]): LyricsChar[] {
  const line = document.lines[index];
  if (!line) return [];
  // Word timings are only usable when they cover every glyph one-to-one; a
  // partially tagged line falls back rather than sweeping out of step.
  if (
    line.chars.length === chars.length &&
    line.chars.every((entry) => entry.time >= 0)
  )
    return line.chars;
  const end = lineEndTime(document, index);
  const span = Math.max(0.2, end - line.time);
  const step = span / Math.max(1, chars.length);
  return chars.map((char, i) => ({ time: line.time + i * step, char }));
}

/** Display width used to weigh the karaoke sweep; CJK glyphs count double. */
export function charWidth(char: string) {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x2e80 && code <= 0xa4cf) return 1;
  if (code >= 0xac00 && code <= 0xd7af) return 1;
  if (code >= 0xf900 && code <= 0xfaff) return 1;
  if (code >= 0xff00 && code <= 0xff60) return 1;
  if (code >= 0x1f300) return 1;
  return 0.5;
}

/**
 * Clip fraction for the karaoke layer, weighted so Latin words sweep at the
 * same visual rate as Chinese ones.
 */
export function karaokeClip(chars: string[], timeline: LyricsChar[], time: number) {
  if (!chars.length) return 0;
  let total = 0;
  let lit = 0;
  for (let index = 0; index < chars.length; index++) {
    const width = charWidth(chars[index]);
    total += width;
    if (timeline[index] && timeline[index].time <= time) lit += width;
  }
  return total > 0 ? Math.min(1, lit / total) : 0;
}

/** Splits a lyric line into grapheme-ish units; Chinese counts per character. */
export function splitChars(text: string) {
  return [...text];
}
