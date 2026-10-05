import archiveOverrides from "../content/album-archives.json" with { type: "json" };
import type { MusicAlbum } from "./music-types.ts";

/**
 * The album archive — the structured "发行背景 / 专辑意义 / 档案要点" panel that
 * sits between the parameter table and the tabs.
 *
 * It resolves from three layers, in order, and always reports which one it used
 * so the interface never presents an inference as a sourced fact:
 *
 * 1. `content/album-archives.json` — hand-entered background, significance and
 *    reference list. This is the only layer allowed to state external facts,
 *    because a human put them there and attached a source.
 * 2. The album's already-verified local introduction (`album.description`),
 *    fetched and checked by the introduction pipeline.
 * 3. Facts derived from the library itself — counts, durations, tag coverage.
 *    These are arithmetic on local data, so they are always available and are
 *    what keeps the panel from being an empty shell on a fresh install.
 */

export interface AlbumArchiveFact {
  label: string;
  value: string;
}

export interface AlbumArchiveSource {
  name: string;
  url?: string;
  license?: string;
  checkedAt?: string;
}

export interface AlbumArchiveBlock {
  heading: string;
  body: string;
  source?: AlbumArchiveSource;
}

export interface AlbumArchive {
  /** Which layer the text blocks came from. */
  status: "manual" | "library" | "derived";
  /** One sentence derived from local data; never a sourced claim. */
  lead: string;
  blocks: AlbumArchiveBlock[];
  facts: AlbumArchiveFact[];
  sources: AlbumArchiveSource[];
  /** Present when the text blocks are missing and can be filled in. */
  hint?: string;
}

/** The shape one entry in `album-archives.json` may take. */
interface ArchiveOverride {
  releaseBackground?: string;
  significance?: string;
  blocks?: { heading?: string; body?: string }[];
  facts?: { label?: string; value?: string }[];
  sources?: AlbumArchiveSource[];
}

interface ArchiveFile {
  albums?: Record<string, ArchiveOverride>;
}

/** Where an album sits in the shelf, when the caller knows. */
export interface AlbumArchiveContext {
  /** 1-based position in the whole library. */
  ordinal?: number;
  libraryCount?: number;
  /** Column title and 1-based position inside it. */
  column?: string;
  columnIndex?: number;
  columnCount?: number;
}

const FILE = archiveOverrides as ArchiveFile;

/** Collapses whitespace so a folder written with either slash still matches. */
function key(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/\s+/g, " ").toLowerCase();
}

/** Lookup keys, most specific first: id, then artist/title, then folder. */
function candidateKeys(album: MusicAlbum) {
  return [
    key(album.id),
    key(`${album.artist} - ${album.title}`),
    key(`${album.artist}-${album.title}`),
    key(album.folder),
    key(album.title),
  ];
}

function findOverride(album: MusicAlbum, file: ArchiveFile): ArchiveOverride | undefined {
  const albums = file.albums ?? {};
  // Index once per lookup; the file is tiny and the call happens per detail view.
  const byKey = new Map<string, ArchiveOverride>();
  for (const [name, record] of Object.entries(albums)) byKey.set(key(name), record);
  for (const candidate of candidateKeys(album)) {
    const record = byKey.get(candidate);
    if (record) return record;
  }
  return undefined;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function clock(value: number) {
  const n = Math.max(0, Math.round(value || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

function formatRange(values: number[], format: (n: number) => string) {
  const unique = [...new Set(values.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  if (!unique.length) return "";
  return unique.length === 1
    ? format(unique[0])
    : `${format(unique[0])}–${format(unique[unique.length - 1])}`;
}

/** Arithmetic over local files only; no external claim is made here. */
function derivedFacts(album: MusicAlbum, context: AlbumArchiveContext) {
  const facts: AlbumArchiveFact[] = [];
  if (context.ordinal) {
    facts.push({
      label: "档案编号",
      value: `ALBUM ${String(context.ordinal).padStart(3, "0")}${context.libraryCount ? ` / ${String(context.libraryCount).padStart(3, "0")}` : ""}`,
    });
  }
  if (context.column) {
    facts.push({
      label: "所在分栏",
      value: `${context.column}${context.columnIndex && context.columnCount ? ` · 第 ${context.columnIndex} / ${context.columnCount} 栏` : ""}`,
    });
  }
  const durations = album.tracks.map((track) => track.duration).filter((value) => value > 0);
  if (durations.length) {
    const longest = album.tracks.reduce((best, track) => (track.duration > best.duration ? track : best), album.tracks[0]);
    const average = durations.reduce((sum, value) => sum + value, 0) / durations.length;
    facts.push({ label: "时长分布", value: `平均 ${clock(average)} · 最长 ${clock(longest.duration)}` });
    if (longest.title) facts.push({ label: "最长曲目", value: longest.title });
  }
  // Tag coverage is worth showing because it is what the credits and the
  // introduction pipeline depend on.
  const coverage = [
    album.year ? "年份" : "",
    album.rawGenres.length ? "流派" : "",
    album.producers.length ? "制作人员" : "",
  ].filter(Boolean);
  facts.push({ label: "标签完整度", value: coverage.length ? `已提供 ${coverage.join(" / ")}` : "尚无年份、流派与制作人员标签" });
  const lossless = album.tracks.filter((track) => track.lossless).length;
  if (lossless && lossless < album.tracks.length) {
    facts.push({ label: "无损占比", value: `${lossless} / ${album.tracks.length} 首无损` });
  } else if (lossless === album.tracks.length && album.tracks.length) {
    facts.push({ label: "无损占比", value: "全部为无损" });
  }
  const specs = formatRange(album.tracks.map((track) => track.sampleRate ?? 0), (n) => `${Number((n / 1000).toFixed(1))} kHz`);
  if (specs) facts.push({ label: "采样率范围", value: specs });
  return facts;
}

/** One sentence describing the album from local data alone. */
function derivedLead(album: MusicAlbum) {
  const duration = album.tracks.reduce((sum, track) => sum + track.duration, 0);
  const parts = [
    album.year ? `${album.year} 年` : "",
    `${album.tracks.length} 首曲目`,
    duration > 0 ? `共 ${clock(duration)}` : "",
  ].filter(Boolean);
  return `${album.artist} · ${album.title}${parts.length ? `：${parts.join("，")}` : ""}。`;
}

function manualBlocks(record: ArchiveOverride) {
  const blocks: AlbumArchiveBlock[] = [];
  const background = text(record.releaseBackground);
  if (background) blocks.push({ heading: "发行背景", body: background });
  const significance = text(record.significance);
  if (significance) blocks.push({ heading: "专辑意义", body: significance });
  for (const block of record.blocks ?? []) {
    const heading = text(block?.heading);
    const body = text(block?.body);
    if (heading && body) blocks.push({ heading, body });
  }
  return blocks;
}

/**
 * Resolves one album's archive. `file` exists so tests can resolve against a
 * fixture without touching the shipped overrides; production always passes the
 * file imported from `content/`.
 */
export function resolveAlbumArchive(
  album: MusicAlbum,
  context: AlbumArchiveContext = {},
  file: ArchiveFile = FILE,
): AlbumArchive {
  const record = findOverride(album, file);
  const facts = derivedFacts(album, context);
  const lead = derivedLead(album);
  const blocks = record ? manualBlocks(record) : [];
  const manualFacts = record?.facts
    ?.map((fact) => ({ label: text(fact?.label), value: text(fact?.value) }))
    .filter((fact) => fact.label && fact.value) ?? [];
  const manualSources = (record?.sources ?? []).filter((source) => text(source?.name));
  if (blocks.length || manualFacts.length) {
    return {
      status: "manual",
      lead,
      blocks,
      facts: [...manualFacts, ...facts],
      sources: manualSources,
    };
  }
  const description = text(album.description);
  if (description) {
    const source = album.descriptionSource;
    const attributed = source?.name
      ? { name: source.name, url: source.url, license: source.license, checkedAt: source.checkedAt }
      : undefined;
    return {
      status: "library",
      lead,
      // The introduction pipeline only stores text it could attribute, so this
      // block carries its source with it.
      blocks: [{ heading: "专辑简介", body: description, source: attributed }],
      facts,
      sources: attributed ? [attributed] : [],
      hint: "发行背景与专辑意义可在 content/album-archives.json 中人工补录，补录内容会连同来源一起显示在这里。",
    };
  }
  return {
    status: "derived",
    lead,
    blocks: [],
    facts,
    sources: [],
    hint: "发行背景与专辑意义尚未录入。可在「02 专辑介绍」中查询已核对的介绍，或在 content/album-archives.json 中人工补录并注明来源。",
  };
}

const STATUS_LABEL: Record<AlbumArchive["status"], string> = {
  manual: "人工补录",
  library: "本地已核对",
  derived: "由本地数据推导",
};

/**
 * Markup for the archive panel. Kept next to the resolver so the data contract
 * and what the interface promises about it cannot drift apart.
 */
export function albumArchiveMarkup(archive: AlbumArchive, escape: (value: string) => string) {
  const esc = escape;
  const blocks = archive.blocks
    .map((block) => `<article class="archive-block"><h3>${esc(block.heading)}</h3><p>${esc(block.body)}</p>${
      block.source?.url
        ? `<a class="text-button" href="${esc(block.source.url)}" target="_blank" rel="noopener">来源：${esc(block.source.name)} ↗</a>`
        : block.source
          ? `<small class="archive-origin">来源：${esc(block.source.name)}</small>`
          : ""
    }</article>`)
    .join("");
  const facts = archive.facts
    .map((fact) => `<div><dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd></div>`)
    .join("");
  const sources = archive.sources
    .map((source) => {
      const label = source.url
        ? `<a href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.name)} ↗</a>`
        : `<span>${esc(source.name)}</span>`;
      return `<li>${label}${source.license ? `<small>${esc(source.license)}</small>` : ""}${source.checkedAt ? `<small>核对于 ${esc(source.checkedAt)}</small>` : ""}</li>`;
    })
    .join("");
  return `<section class="album-archive" data-status="${archive.status}">
    <header class="archive-head"><small>ARCHIVE <i>／</i> 档案</small><span class="archive-status">${esc(STATUS_LABEL[archive.status])}</span></header>
    <p class="archive-lead">${esc(archive.lead)}</p>
    ${blocks ? `<div class="archive-blocks">${blocks}</div>` : ""}
    ${facts ? `<dl class="archive-facts">${facts}</dl>` : ""}
    ${sources ? `<div class="archive-sources"><small>资料来源</small><ul>${sources}</ul></div>` : ""}
    ${archive.hint ? `<p class="archive-hint">${esc(archive.hint)}</p>` : ""}
  </section>`;
}
