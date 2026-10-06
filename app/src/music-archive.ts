import archiveOverrides from "../content/album-archives.json" with { type: "json" };
import type { MusicAlbum } from "./music-types.ts";

/**
 * The album archive — the structured "发行背景 / 专辑意义 / 档案要点" panel that
 * sits between the parameter table and the tabs.
 *
 * It resolves from four layers, in order, and always reports which one it used
 * so the interface never presents an inference as a sourced fact:
 *
 * 1. `content/album-archives.json` — hand-entered background, significance and
 *    reference list. This is the only layer allowed to state external facts
 *    without being fetched, because a human put them there and attached a
 *    source. An editor's judgement outranks every machine-fetched layer.
 * 2. The on-demand online supplement (`GET /api/album-online/:id`), passed in
 *    through the context. It is fetched live, quotes and summarises only what a
 *    source returned, and carries a source and licence per contribution.
 * 3. The album's already-verified local introduction (`album.description`),
 *    fetched and checked by the introduction pipeline and stored in the index.
 *    It ranks below the live supplement because it can be stale or absent.
 * 4. Facts derived from the library itself — counts, durations, tag coverage.
 *    These are arithmetic on local data, so they are always available and are
 *    what keeps the panel from being an empty shell on a fresh install.
 *
 * Only layers 1 and 2 may produce prose blocks, and every block from either of
 * them carries its source; layers 3 and 4 are surfaced as facts or as a
 * previously attributed paragraph.
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

/** One upstream source's outcome, reported verbatim by the resolver. */
export interface AlbumArchiveProviderNote {
  id: string;
  label: string;
  /** `ok` / `empty` / `failed` / `skipped`, straight from the resolver. */
  status: string;
  detail?: string;
}

/**
 * The online supplement as `GET /api/album-online/:id` returns it. It is passed
 * in by the caller rather than fetched here, so this module stays a pure
 * function of its inputs and stays testable without a network.
 */
export interface AlbumArchiveOnline {
  status: "ok" | "empty" | "error" | "disabled";
  blocks?: AlbumArchiveBlock[];
  facts?: AlbumArchiveFact[];
  sources?: AlbumArchiveSource[];
  providers?: AlbumArchiveProviderNote[];
  /** Why nothing was adopted. */
  error?: string;
  /** Set instead of `error` when the feature is switched off. */
  reason?: string;
  searchUrl?: string;
  checkedAt?: string;
  cached?: boolean;
}

export interface AlbumArchive {
  /** Which layer the text blocks came from. */
  status: "manual" | "online" | "library" | "derived";
  /** One sentence derived from local data; never a sourced claim. */
  lead: string;
  blocks: AlbumArchiveBlock[];
  facts: AlbumArchiveFact[];
  sources: AlbumArchiveSource[];
  /**
   * Sources that were asked and did not answer, kept so "nothing was found" and
   * "nothing could be reached" never look the same.
   */
  providers?: AlbumArchiveProviderNote[];
  /** Manual escape hatch, shown when no prose was obtained from any source. */
  searchUrl?: string;
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
  /**
   * The online supplement, when one has been requested for this album. Absent
   * means "never asked", which must not read the same as "asked and empty" —
   * that difference is what the panel's hint line reports.
   */
  online?: AlbumArchiveOnline | null;
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
  // A hand-entered record is an editor's judgement, so it outranks every
  // machine-fetched layer and short-circuits the rest of the resolution.
  if (blocks.length || manualFacts.length) {
    return {
      status: "manual",
      lead,
      blocks,
      facts: [...manualFacts, ...facts],
      sources: manualSources,
    };
  }

  // The stored introduction: fetched and checked earlier, then kept in the
  // index. It is attributed, so it may be shown as prose.
  const description = text(album.description);
  const librarySource =
    description && album.descriptionSource?.name
      ? {
          name: album.descriptionSource.name,
          url: album.descriptionSource.url,
          license: album.descriptionSource.license,
          checkedAt: album.descriptionSource.checkedAt,
        }
      : undefined;
  const libraryBlock: AlbumArchiveBlock | undefined = description
    ? { heading: "专辑简介", body: description, source: librarySource }
    : undefined;

  // The live supplement. It carries its own per-source attribution, so it is
  // allowed prose, but it never overrules the hand-entered layer above.
  const online = context.online;
  const onlineBlocks = (online?.blocks ?? []).filter(
    (block) => text(block?.heading) && text(block?.body),
  );
  const onlineFacts = (online?.facts ?? [])
    .map((fact) => ({ label: text(fact?.label), value: text(fact?.value) }))
    .filter((fact) => fact.label && fact.value);
  const onlineSources = (online?.sources ?? []).filter((source) => text(source?.name));

  if (online && (onlineBlocks.length || onlineFacts.length)) {
    const merged = [...onlineBlocks];
    // The live answer may already contain prose under this heading; stacking a
    // second 专辑简介 would read as two competing introductions.
    if (libraryBlock && !merged.some((block) => block.heading === libraryBlock.heading))
      merged.push(libraryBlock);
    const sources = [...onlineSources];
    if (librarySource && !sources.some((source) => source.name === librarySource.name))
      sources.push(librarySource);
    const unanswered = (online.providers ?? []).filter(
      (provider) => provider.status !== "ok",
    );
    const hasProse = merged.some((block) => block.heading === "专辑简介");
    return {
      status: "online",
      lead,
      blocks: merged,
      facts: [...onlineFacts, ...facts],
      sources,
      ...(unanswered.length ? { providers: unanswered } : {}),
      // The search link is only worth offering while there is still no prose.
      ...(hasProse || !online.searchUrl ? {} : { searchUrl: online.searchUrl }),
      hint:
        "线上内容逐条取自国内可访问的公开元数据源（QQ 音乐 / 网易云音乐 / 百度百科 / MusicBrainz）并随附出处，与本机缓存 30 天。人工补录（content/album-archives.json）优先级高于线上内容。",
    };
  }

  // Nothing was adopted. When someone asked for a supplement, say why instead
  // of leaving the panel looking like the question was never put.
  const onlineError = online
    ? text(online.error) ||
      text(online.reason) ||
      (online.status === "empty" ? "公开来源未找到与本地标签可靠对应的条目。" : "")
    : "";
  const onlineNote = onlineError ? ` 线上补录未采用任何内容：${onlineError}` : "";
  const searchUrl = online?.searchUrl;

  if (libraryBlock) {
    return {
      status: "library",
      lead,
      // The introduction pipeline only stores text it could attribute, so this
      // block carries its source with it.
      blocks: [libraryBlock],
      facts,
      sources: librarySource ? [librarySource] : [],
      ...(searchUrl ? { searchUrl } : {}),
      hint: `发行背景与专辑意义可在 content/album-archives.json 中人工补录，补录内容会连同来源一起显示在这里。${onlineNote}`,
    };
  }
  return {
    status: "derived",
    lead,
    blocks: [],
    facts,
    sources: [],
    ...(searchUrl ? { searchUrl } : {}),
    hint: `发行背景与专辑意义尚未录入。可用「线上补充详情与背景」读取公开元数据，或在 content/album-archives.json 中人工补录并注明来源。${onlineNote}`,
  };
}

const STATUS_LABEL: Record<AlbumArchive["status"], string> = {
  manual: "人工补录",
  online: "线上补录",
  library: "本地已核对",
  derived: "由本地数据推导",
};

/** The one control the panel owns; omitted in fixtures, so markup stays pure. */
export interface AlbumArchiveActions {
  /** Album the button acts on. Without it no control row is rendered. */
  albumId?: string;
  /** True while a supplement is in flight. */
  busy?: boolean;
  /** True once a supplement has been adopted, so the button offers a refresh. */
  adopted?: boolean;
  /** Progress or failure text; empty renders nothing. */
  notice?: string;
}

/**
 * Markup for the archive panel. Kept next to the resolver so the data contract
 * and what the interface promises about it cannot drift apart.
 *
 * `actions` is optional so a fixture can render the panel with no button; when
 * it carries an album id the panel also owns the online-supplement control.
 */
export function albumArchiveMarkup(
  archive: AlbumArchive,
  escape: (value: string) => string,
  actions: AlbumArchiveActions = {},
) {
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
  // What was asked and did not answer. Kept separate from 资料来源 so a source
  // that contributed is never confused with one that failed.
  const unanswered = (archive.providers ?? [])
    .map(
      (provider) =>
        `<li><span>${esc(provider.label)}</span><small>${esc(provider.detail || provider.status)}</small></li>`,
    )
    .join("");
  const controls = actions.albumId
    ? `<div class="archive-actions"><button class="text-button" data-action="online-album"${actions.busy ? " disabled" : ""}>${
        actions.busy
          ? "正在读取线上资料…"
          : actions.adopted
            ? "重新读取线上资料 ↗"
            : "线上补充详情与背景 ↗"
      }</button>${
        archive.searchUrl
          ? `<a class="text-button" href="${esc(archive.searchUrl)}" target="_blank" rel="noopener">在百度搜索更多 ↗</a>`
          : ""
      }<p class="archive-online-status" data-online-feedback="${esc(actions.albumId)}" role="status">${esc(actions.notice ?? "")}</p></div>`
    : "";
  return `<section class="album-archive" data-status="${archive.status}">
    <header class="archive-head"><small>ARCHIVE <i>／</i> 档案</small><span class="archive-status">${esc(STATUS_LABEL[archive.status])}</span></header>
    <p class="archive-lead">${esc(archive.lead)}</p>
    ${blocks ? `<div class="archive-blocks">${blocks}</div>` : ""}
    ${facts ? `<dl class="archive-facts">${facts}</dl>` : ""}
    ${sources ? `<div class="archive-sources"><small>资料来源</small><ul>${sources}</ul></div>` : ""}
    ${unanswered ? `<div class="archive-sources archive-unanswered"><small>未采用的来源</small><ul>${unanswered}</ul></div>` : ""}
    ${archive.hint ? `<p class="archive-hint">${esc(archive.hint)}</p>` : ""}
    ${controls}
  </section>`;
}
