import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseFile } from 'music-metadata'

/**
 * Lyrics are read on demand instead of during the scan. Two reasons:
 *
 * 1. Lyrics would multiply the size of music-index.json, and that file is read
 *    and rewritten on every scan; the shelf does not need a word of it.
 * 2. Unlike covers there is no thumbnail to precompute, so the only cost is a
 *    tag read, and the pane is only ever opened after the user starts a drag.
 *
 * The result is cached per file fingerprint, so reopening the pane is free.
 */

const CACHE_LIMIT = 256
/** Keeps a pathological tag from becoming a multi-megabyte JSON response. */
const MAX_LYRICS_BYTES = 512 * 1024
const MAX_SYNC_ENTRIES = 5000
/** Same-name sidecar files, most specific first. */
const LRC_SUFFIXES = ['.lrc', '.LRC', '.zh.lrc', '.zh-CN.lrc', '.zh_CN.lrc']

const cache = new Map()

export function resetLyricsCache() {
  cache.clear()
}

export function lyricsCacheSize() {
  return cache.size
}

function remember(key, fingerprint, payload) {
  if (cache.size >= CACHE_LIMIT) {
    // Oldest insertion goes first; a Map iterates in insertion order.
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, { fingerprint, payload })
  return payload
}

/** Windows filesystems ignore case, but a copied library may not. */
async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return { file: candidate, stat }
    } catch { /* try the next spelling */ }
  }
  return null
}

/**
 * LRC files in the wild are frequently GB18030 rather than UTF-8. A decoding
 * attempt that produced replacement characters is treated as a mis-decode and
 * retried with the Chinese code pages before giving up on the sidecar.
 */
function decodeText(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer)
  if (!utf8.includes('\uFFFD')) return utf8
  for (const encoding of ['gb18030', 'gbk', 'big5']) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: false }).decode(buffer)
      if (!decoded.includes('\uFFFD')) return decoded
    } catch { /* encoding unavailable in this Node build */ }
  }
  return utf8
}

async function readSidecar(audioFile, allowedRoot) {
  const directory = path.dirname(audioFile)
  const base = path.parse(audioFile).name
  const found = await firstExisting(LRC_SUFFIXES.map((suffix) => path.join(directory, `${base}${suffix}`)))
  if (!found) return null
  const resolved = await fs.realpath(found.file)
  const root = await fs.realpath(allowedRoot)
  const relative = path.relative(root, resolved)
  // A sidecar outside the configured music directory is never read.
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  const stat = await fs.stat(resolved)
  if (stat.size > MAX_LYRICS_BYTES) return null
  const buffer = await fs.readFile(resolved)
  const text = decodeText(buffer).replace(/^\uFEFF/, '')
  return {
    payload: { source: 'lrc', text },
    fingerprintExtra: `${stat.size}:${stat.mtimeMs}`,
  }
}

/** USLT arrives as `text`, SYLT as `syncText`; sync is the better of the two. */
function fromTags(metadata) {
  const tags = metadata?.common?.lyrics
  if (!Array.isArray(tags) || !tags.length) return null
  const synced = tags.find((tag) => Array.isArray(tag?.syncText) && tag.syncText.length)
  if (synced) {
    const sync = synced.syncText
      .slice(0, MAX_SYNC_ENTRIES)
      .map((entry) => ({ text: typeof entry?.text === 'string' ? entry.text : '', timestamp: Number(entry?.timestamp) }))
      .filter((entry) => entry.text && Number.isFinite(entry.timestamp) && entry.timestamp >= 0)
    if (sync.length) return { source: 'sylt', sync }
  }
  const plain = tags.find((tag) => typeof tag?.text === 'string' && tag.text.trim())
  if (!plain) return null
  const text = plain.text.slice(0, MAX_LYRICS_BYTES)
  return { source: 'uslt', text }
}

/**
 * @param {{ path: string, allowedRoot: string }} track Audio file and the music
 *   root it must stay inside, as returned by `MusicLibraryStore.trackFile`.
 */
export async function readLyrics(track, { parseFileImpl = parseFile } = {}) {
  const audioFile = track.path
  const stat = await fs.stat(audioFile)
  // The sidecar's own fingerprint participates, so editing a .lrc invalidates
  // the cache without touching the audio file.
  const sidecar = await readSidecar(audioFile, track.allowedRoot)
  const fingerprint = `${stat.size}:${stat.mtimeMs}:${sidecar?.fingerprintExtra ?? ''}`
  const cached = cache.get(audioFile)
  if (cached && cached.fingerprint === fingerprint) return cached.payload
  if (sidecar) return remember(audioFile, fingerprint, sidecar.payload)
  let fromTag = null
  try {
    // Covers were already resolved during the scan, and the duration is not
    // needed here, so this stays a tag-only read.
    const metadata = await parseFileImpl(audioFile, { duration: false, skipCovers: true })
    fromTag = fromTags(metadata)
  } catch { /* an unreadable tag block is not an error; it means no lyrics */ }
  return remember(audioFile, fingerprint, fromTag ?? { source: 'none' })
}
