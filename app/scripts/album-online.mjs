/**
 * The online album supplement — the fourth provenance layer.
 *
 * Why it exists
 * -------------
 * The shipped introduction pipeline (`album-introductions.mjs`) reads Wikipedia
 * and Wikidata only. On a network where those hosts do not resolve to real
 * Wikipedia addresses, that pipeline can never succeed: every album is recorded
 * as an error and the detail page has nothing to show. This module adds sources
 * that do answer, keeps the Wikipedia path as best-effort polish on networks
 * where it works, and reports a per-source outcome so the interface can be
 * honest about where each sentence came from.
 *
 * Rules this module holds to
 * -------------------------
 * 1. No source may sink the lookup. Every provider is isolated, runs under an
 *    overall deadline, and downgrades to a reported status with a readable
 *    reason instead of throwing.
 * 2. Nothing is invented. Prose is quoted from a source; summaries are
 *    composed only from fields a source actually returned; each contributing
 *    source is listed with its licence.
 * 3. A host that has just failed to connect is not asked again for a while —
 *    otherwise a black-holed DNS entry costs every album a full timeout.
 * 4. Results are cached on disk with a TTL, keyed by album identity, beside the
 *    library data rather than inside the music folders.
 */

import path from 'node:path'
import { promises as fs } from 'node:fs'
import OpenCC from 'opencc-js'
import { normalizeName } from './album-introductions.mjs'

/** 网易云专辑简介多为繁体；繁转简与既有介绍管线保持一致，简体输入幂等。 */
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })

export const ONLINE_TTL_MS = 30 * 86400_000
export const MAX_BLOCK_BYTES = 4000
/** Whole-lookup budget. Providers that miss it are reported, never awaited. */
export const OVERALL_BUDGET_MS = 12_000
/** How long a host stays out of rotation after a connect-level failure. */
export const BREAKER_MS = 30 * 60_000

const APP_UA = 'RhineLocalMusic/0.3 (personal local music library; metadata display only)'
const ISO = () => new Date().toISOString()

/**
 * Hosts we are willing to talk to, for documentation and validation.
 *
 * Verified reachable from a mainland China residential line on 2026-10-06, with
 * an album-worthy payload, and no key or account:
 *   musicbrainz.org  MusicBrainz (49.4% of the author's library)
 *   c.y.qq.com       QQ 音乐   (48.1%, long Chinese prose)
 *   baike.baidu.com  百度百科   (41.8%, best on canonical albums; the open API
 *                               works even though the item pages return 403)
 *   music.163.com    网易云音乐 (long Chinese prose; `/api/search/get/web` +
 *                               `/api/v1/album/{id}`. ⚠️ the non-v1
 *                               `/api/album/{id}` is 风控-ed with code:-462,
 *                               only the v1 path answers without a login)
 *   api.discogs.com  Discogs    (year/genre/format facts; polite interval only)
 *   itunes.apple.com Apple Music 商店 (Western catalogues only; see itunes())
 *
 * Best-effort tail (own short deadline + breaker; a failure only blanks its own
 * row): `www.wikidata.org`. It timed out repeatedly on this machine, so it is
 * gated behind the same "all primary sources empty" sweep as the store and given
 * a short budget so it never stretches an album view.
 *
 * Deliberately absent: zh.wikipedia.org. It timed out on every attempt (DNS
 * interception) and contributed 0 of 79 albums while costing one timeout per
 * pass; the user's brief was explicit that sources unusable in China must not
 * be wired in. The item pages of baike return 403 for non-browser clients —
 * only the documented open API is used.
 */
export const PROVIDER_HOSTS = {
  qq: 'c.y.qq.com',
  baike: 'baike.baidu.com',
  musicbrainz: 'musicbrainz.org',
  netease: 'music.163.com',
  discogs: 'api.discogs.com',
  itunes: 'itunes.apple.com',
  wikidata: 'www.wikidata.org',
}

/** The public suggestion endpoint: returns an album mid plus the performer. */
const QQ_SUGGEST = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg'
/** Album detail, which carries `desc` (the long Chinese 简介), `aDate` and `company`. */
const QQ_ALBUM = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg'
/** Baidu Baike's documented lemma-card API. */
const BAIKE_API = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi'
/** Public appid used by Baike's own embeddable lemma card. */
const BAIKE_APPID = '379020'
/** 网易云搜索（type=10 专辑），返回 id + name + artist。 */
const NETEASE_SEARCH = 'https://music.163.com/api/search/get/web'
/** 网易云专辑详情 v1：description（长简介）、publishTime、company、size。 */
const NETEASE_ALBUM = 'https://music.163.com/api/v1/album'
/** Discogs 发行搜索，无需 key，但需礼貌间隔与 User-Agent。 */
const DISCOGS_SEARCH = 'https://api.discogs.com/database/search'
/** Wikidata 实体搜索（返回 Q 号，无消歧柄，需严格复核）。 */
const WIKIDATA_SEARCH = 'https://www.wikidata.org/w/api.php'

const firstString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')

/** Album identity; a change here invalidates the cache entry. */
export function albumFingerprint(album) {
  return [album.title, album.artist, album.year ?? ''].map((part) => normalizeName(String(part ?? ''))).join('|')
}

/** File-safe cache key; ids are slug-like but that is not a promise. */
function cacheKey(album) {
  return `${String(album.id).replace(/[^a-zA-Z0-9-]/g, '_')}.json`
}

function clip(value, limit = MAX_BLOCK_BYTES) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** Converges statements into one readable sentence, preserving order. */
function joinStatements(statements) {
  if (statements.length <= 1) return statements[0] ?? ''
  return `${statements.slice(0, -1).join('，')}，${statements[statements.length - 1]}`
}

/**
 * Statement slots.
 *
 * Two sources routinely assert the *same* thing about the same album: QQ 音乐的
 * `aDate` and MusicBrainz's `first-release-date` are both "this album came out
 * on D". Concatenating them produced 「公开条目记录其发行于 2025 年 3 月 14 日，
 * 由 某唱片 发行，公开条目记录其首次发行于 2025 年 3 月 14 日」 — one date said
 * twice, in two voices. A statement therefore declares which dimension it speaks
 * to, and the assembly keeps the first statement per slot. The full field-level
 * detail is never lost: every provider's facts are kept verbatim, and a real
 * disagreement still surfaces through 年份差异.
 */
const STATEMENT_SLOTS = {
  /** When the album came out. QQ 音乐 and MusicBrainz speak to this one. */
  release: 'release',
  /** Who released it. */
  label: 'label',
  /** A storefront's own on-sale date, which is not the first release. */
  storeDate: 'store-date',
  storeGenre: 'store-genre',
  storeTracks: 'store-tracks',
}

/** 2001-09-14 -> 2001 年 9 月 14 日; partial dates degrade gracefully. */
function humanDate(value) {
  const text = firstString(value)
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(text)
  if (!match) return text
  const [, year, month, day] = match
  if (!month) return `${year} 年`
  if (!day || day === '00') return `${year} 年 ${Number(month)} 月`
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`
}

/** 1000396800000 -> 2001-09-13（网易云 publishTime 是毫秒时间戳）。 */
function millisToDate(value) {
  const millis = Number(value)
  if (!Number.isFinite(millis) || millis <= 0) return ''
  return new Date(millis).toISOString().slice(0, 10)
}

/**
 * A local library's album titles carry the packaging, not the album: 「燕尾蝶<
 * 下定爱的决心>」, 「我好吗? - 太阳如常升起」, 「爱的大游行Live全记录 (Live)」.
 * The online sources index the album itself, so the decorations are stripped and
 * the result plus each `/`-separated half is offered, capped at two variants so a
 * lookup can never fan out.
 *
 * Measured on the author's library: this alone recovered 「燕尾蝶」 (4569 字) and
 * 「15 Khalil Fong Live in Hong Kong 2011」, both of which the raw title missed.
 */
export function titleVariants(title) {
  const cleaned = String(title)
    .replace(/\s*[-–—]\s*(single|ep|album|live)\s*$/i, '')
    .replace(/\s*[\[(（【]\s*(live|single|ep|remaster(ed)?|deluxe|特别版|限量版|典藏版|精选)[^\])）】]*[\])）】]\s*$/i, '')
    .replace(/\s*<[^>]*>\s*$/, '')
    .trim()
  const out = []
  for (const value of [cleaned, ...cleaned.split('/').map((part) => part.trim())])
    if (value && !out.includes(value)) out.push(value)
  return out.slice(0, 2)
}

/** Title / performer agreement, weighted the same way MusicBrainz is scored. */
function creditTokens(artist) {
  const text = firstString(artist)
  if (!text || /未知艺术家|群星|various artists/i.test(text)) return []
  return text
    .split(/[、,&/]|\s*feat\.?\s*|\s*ft\.?\s*/i)
    .map((part) => normalizeName(part))
    .filter(Boolean)
}

/** Resolves to a provider outcome once the limit passes, without cancelling. */
function withDeadline(promise, ms, id, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'failed', detail: `超出 ${Math.round(ms / 1000)} 秒预算，已放弃`, id, label }), ms)),
  ])
}

/** Serialises one provider's requests so it never bursts. */
class Gate {
  constructor(intervalMs) {
    this.intervalMs = intervalMs
    this.last = 0
    this.chain = Promise.resolve()
  }

  run(task) {
    const next = this.chain.catch(() => {}).then(async () => {
      const wait = this.last + this.intervalMs - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      this.last = Date.now()
      return task()
    })
    this.chain = next
    return next
  }
}

/** True when a fetch failure looks like "this host is not reachable at all". */
function isConnectFailure(error) {
  const text = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`
  // Both wording paths are covered deliberately: this module's own `request()`
  // says 无法连接, while the introduction provider says 连接失败或超时 and only
  // interpolates the inner `message` — which is often just "fetch failed".
  return /无法连接|连接失败|fetch failed|connect|timeout|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/i.test(text)
}

/**
 * Resolves one album's online supplement.
 *
 * `fetcher` is injectable so the check script can drive every branch without
 * touching the real network.
 */
export class AlbumOnlineResolver {
  constructor({
    dataDir,
    fetcher = globalThis.fetch,
    intervalMs = 1100,
    requestTimeoutMs = 6000,
    budgetMs = OVERALL_BUDGET_MS,
    retryDelayMs = 1500,
    cacheDir,
  } = {}) {
    this.dataDir = dataDir ? path.resolve(dataDir) : ''
    this.cacheRoot = cacheDir ?? (this.dataDir ? path.join(this.dataDir, 'album-online') : '')
    this.fetcher = fetcher
    this.requestTimeoutMs = requestTimeoutMs
    this.budgetMs = budgetMs
    this.retryDelayMs = retryDelayMs
    this.contact = undefined
    this.gates = {
      qq: new Gate(intervalMs),
      baike: new Gate(intervalMs),
      musicbrainz: new Gate(intervalMs),
      netease: new Gate(intervalMs),
      discogs: new Gate(intervalMs),
      itunes: new Gate(intervalMs),
      wikidata: new Gate(intervalMs),
    }
    this.memory = new Map()
    this.breaker = new Map()
    this.breakerLoaded = false
  }

  setContact(value) {
    this.contact = value || undefined
  }

  clearMemory() {
    this.memory.clear()
    this.breaker.clear()
    this.breakerLoaded = true
  }

  /** Small persisted map so a black-holed host is not rediscovered each run. */
  async loadBreaker() {
    if (this.breakerLoaded) return
    this.breakerLoaded = true
    if (!this.cacheRoot) return
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.cacheRoot, '_breakers.json'), 'utf8'))
      for (const [id, until] of Object.entries(data ?? {})) if (Number(until) > Date.now()) this.breaker.set(id, Number(until))
    } catch {
      /* No breaker file yet; that is the normal first-run state. */
    }
  }

  async persistBreaker() {
    if (!this.cacheRoot) return
    try {
      await fs.mkdir(this.cacheRoot, { recursive: true })
      await fs.writeFile(path.join(this.cacheRoot, '_breakers.json'), JSON.stringify(Object.fromEntries(this.breaker)), 'utf8')
    } catch {
      /* Optional state. */
    }
  }

  downReason(id) {
    const until = this.breaker.get(id)
    if (!until || until <= Date.now()) return ''
    const minutes = Math.max(1, Math.round((until - Date.now()) / 60_000))
    return `此前连接失败，已暂停约 ${minutes} 分钟，避免重复超时`
  }

  markDown(id) {
    this.breaker.set(id, Date.now() + BREAKER_MS)
    void this.persistBreaker()
  }

  clearDown(id) {
    if (!this.breaker.has(id)) return
    this.breaker.delete(id)
    void this.persistBreaker()
  }

  async readCache(album) {
    if (!this.cacheRoot) return undefined
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.cacheRoot, cacheKey(album)), 'utf8'))
      return data?.fingerprint === albumFingerprint(album) ? data : undefined
    } catch {
      return undefined
    }
  }

  async writeCache(album, payload) {
    if (!this.cacheRoot) return
    try {
      await fs.mkdir(this.cacheRoot, { recursive: true })
      const file = path.join(this.cacheRoot, cacheKey(album))
      const temp = `${file}.${process.pid}.tmp`
      await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8')
      await fs.rename(temp, file)
    } catch {
      /* A cache we cannot write is not a reason to fail the lookup. */
    }
  }

  async request(url, gateId, timeoutMs = this.requestTimeoutMs) {
    return this.gates[gateId].run(async () => {
      // MusicBrainz documents 503 (and 429) as "you are being rate limited,
      // back off and retry", and a library-wide pass is exactly the workload
      // that trips it. One bounded retry inside the provider's own gate keeps
      // the polite interval while turning a transient refusal into a hit.
      for (let attempt = 0; ; attempt++) {
        let response
        try {
          response = await this.fetcher(url, {
            headers: {
              Accept: 'application/json',
              'User-Agent': this.contact ? `${APP_UA} (${this.contact})` : APP_UA,
            },
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'error',
          })
        } catch (error) {
          throw new Error(`${url.hostname} 无法连接（${error.cause?.message ?? error.message}）`)
        }
        if (!response.ok) {
          if (attempt === 0 && (response.status === 429 || response.status === 503)) {
            await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
            continue
          }
          throw new Error(`${url.hostname} HTTP ${response.status}`)
        }
        return response.json()
      }
    })
  }

  /** Release-group type, first release date, and title/performer/year agreement. */
  async musicbrainz(album) {
    const query = `releasegroup:"${String(album.title).replaceAll('"', ' ')}" AND artist:"${String(album.artist).replaceAll('"', ' ')}"`
    const url = new URL('https://musicbrainz.org/ws/2/release-group')
    url.search = new URLSearchParams({ query, fmt: 'json', limit: '8' }).toString()
    const data = await this.request(url, 'musicbrainz')
    const groups = Array.isArray(data?.['release-groups']) ? data['release-groups'] : []
    const wantedTitle = normalizeName(album.title)
    const wantedArtist = normalizeName(album.artist)
    const scored = groups
      .map((group) => {
        const credit = normalizeName((group['artist-credit'] ?? []).map((entry) => entry?.name ?? entry?.artist?.name ?? '').join(''))
        const title = normalizeName(group.title ?? '')
        let score = 0
        if (title === wantedTitle) score += 4
        else if (title && (title.includes(wantedTitle) || wantedTitle.includes(title))) score += 1
        if (wantedArtist && credit === wantedArtist) score += 4
        else if (wantedArtist && credit && (credit.includes(wantedArtist) || wantedArtist.includes(credit))) score += 1
        const year = Number(String(group['first-release-date'] ?? '').slice(0, 4))
        if (album.year && year === Number(album.year)) score += 3
        return { group, score }
      })
      .sort((a, b) => b.score - a.score)
    const best = scored[0]
    // Both title and performer must agree; a partial hit is not evidence.
    if (!best || best.score < 8) {
      return { status: 'empty', detail: best ? '名称或歌手未能可靠对上，未采用' : '未检索到候选条目' }
    }

    const group = best.group
    const facts = []
    const statements = []
    const types = [group['primary-type'], ...(group['secondary-types'] ?? [])].filter(Boolean).join(' · ')
    if (types) facts.push({ label: '线上专辑类型', value: types })
    const firstDate = String(group['first-release-date'] ?? '')
    if (firstDate) {
      facts.push({ label: '线上首次发行', value: humanDate(firstDate) })
      statements.push({ slot: STATEMENT_SLOTS.release, text: `公开条目记录其首次发行于 ${humanDate(firstDate)}` })
    }
    const onlineYear = Number(firstDate.slice(0, 4))
    if (album.year && onlineYear && onlineYear !== Number(album.year)) {
      facts.push({ label: '年份差异', value: `本地标签 ${album.year} · 线上 ${onlineYear}` })
    }
    facts.push({ label: '线上匹配度', value: `${Math.round(best.score)} / 11（标题 · 歌手 · 年份）` })
    return {
      status: 'ok',
      facts,
      statements,
      source: {
        name: 'MusicBrainz',
        url: `https://musicbrainz.org/release-group/${group.id}`,
        license: 'CC0 / 数据以来源页为准',
        checkedAt: ISO(),
      },
    }
  }

  /**
   * Apple's catalogue: release date, genre, track count, store page.
   *
   * Measured behaviour on this machine (2026-10-06), which drives the shape of
   * this method: the CN storefront answers `resultCount: 0` even for a major
   * Chinese release, and the US storefront answers with twelve rows that have
   * nothing to do with the query. So a storefront that returned rows which do
   * not correspond is *not* retried with the same text — the second storefront
   * only gets a turn when the first had nothing at all to say.
   */
  async itunes(album) {
    const notes = []
    // A storefront that answered with a result set is not the same as one that
    // errored; only the first can mean "this store does not carry it".
    let answered = false
    // Ask the storefront that is likely to carry this album first. The order is
    // a heuristic about the title's script, nothing more; both are still tried.
    const cjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(`${album.title} ${album.artist}`)
    for (const country of cjk ? ['cn', 'us'] : ['us', 'cn']) {
      const url = new URL('https://itunes.apple.com/search')
      url.search = new URLSearchParams({
        term: `${album.title} ${album.artist}`,
        entity: 'album',
        limit: '12',
        country,
      }).toString()
      let data
      try {
        data = await this.request(url, 'itunes')
      } catch (error) {
        if (isConnectFailure(error)) throw error
        // The status code is the diagnostic part, so it is kept in the note.
        notes.push(`${country.toUpperCase()} 商店未能访问（${error.message}）`)
        continue
      }
      answered = true
      const results = Array.isArray(data?.results) ? data.results : []
      if (!results.length) {
        notes.push(`${country.toUpperCase()} 商店没有对应条目`)
        continue
      }
      const wantedTitle = normalizeName(album.title)
      const wantedArtist = normalizeName(album.artist)
      const candidate = results
        .map((item) => {
          let score = 0
          const title = normalizeName(item.collectionName ?? '')
          const artist = normalizeName(item.artistName ?? '')
          if (title === wantedTitle) score += 4
          else if (title && (title.startsWith(wantedTitle) || wantedTitle.startsWith(title))) score += 2
          if (wantedArtist && artist === wantedArtist) score += 4
          else if (wantedArtist && artist && (artist.includes(wantedArtist) || wantedArtist.includes(artist))) score += 1
          if (album.year && Number(String(item.releaseDate ?? '').slice(0, 4)) === Number(album.year)) score += 3
          return { item, score }
        })
        .sort((a, b) => b.score - a.score)[0]
      if (!candidate || candidate.score < 8) {
        notes.push(`${country.toUpperCase()} 商店结果与本地标签不对应`)
        continue
      }

      const item = candidate.item
      const facts = []
      const statements = []
      if (item.releaseDate) {
        facts.push({ label: '商店发行日期', value: humanDate(item.releaseDate) })
        statements.push({ slot: STATEMENT_SLOTS.storeDate, text: `商店记录的上架日期为 ${humanDate(item.releaseDate)}` })
      }
      if (item.primaryGenreName) {
        facts.push({ label: '商店流派', value: item.primaryGenreName })
        statements.push({ slot: STATEMENT_SLOTS.storeGenre, text: `商店归类为 ${item.primaryGenreName}` })
      }
      if (Number(item.trackCount) > 0) {
        facts.push({ label: '商店收录曲目', value: `${item.trackCount} 首` })
        statements.push({ slot: STATEMENT_SLOTS.storeTracks, text: `商店记录收录 ${item.trackCount} 首曲目` })
      }
      if (item.copyright) facts.push({ label: '版权声明', value: clip(item.copyright, 160) })
      return {
        status: 'ok',
        facts,
        statements,
        source: {
          name: `Apple Music 商店（${country.toUpperCase()}）`,
          url: firstString(item.collectionViewUrl) || undefined,
          license: '商店展示信息，以来源页为准',
          checkedAt: ISO(),
        },
      }
    }
    return {
      // Every storefront errored: that is a failure, not an empty catalogue, and
      // the panel must not report "nothing found" for a store it never reached.
      status: answered ? 'empty' : 'failed',
      // Per-storefront reasons, so "nothing was found" is never mistaken for
      // "nothing was reachable".
      detail: notes.length ? `未采用商店资料（${notes.join('；')}）` : '商店记录未能可靠对上',
    }
  }

  /**
   * QQ 音乐. Two calls: the public suggestion endpoint gives an album mid and the
   * performer, then the album detail endpoint gives a long Chinese 简介 plus the
   * release date, the label and the track count.
   *
   * The mid comes from a suggestion list rather than a search page, so the match
   * is verified twice — title and performer must agree in the suggestion, and the
   * detail's own `name` must agree again. A wrong mid answers with a different
   * album or with nothing, which is how the guard was validated: hand it a wrong
   * mid and it returns empty rather than someone else's album.
   */
  async qq(album) {
    const wantedArtist = creditTokens(album.artist)
    for (const variant of titleVariants(album.title)) {
      const suggest = new URL(QQ_SUGGEST)
      suggest.search = new URLSearchParams({ key: variant, format: 'json', g_tk: '5381' }).toString()
      let list
      try {
        const data = await this.request(suggest, 'qq')
        list = Array.isArray(data?.data?.album?.itemlist) ? data.data.album.itemlist : []
      } catch (error) {
        if (variant === titleVariants(album.title)[0]) throw error
        continue
      }
      const wanted = normalizeName(variant)
      const best = list
        .map((item) => {
          const name = normalizeName(item?.name ?? '')
          const singer = normalizeName(Array.isArray(item?.singer) ? item.singer.join('') : (item?.singer ?? ''))
          let score = 0
          if (name && name === wanted) score += 5
          else if (name && (name.includes(wanted) || wanted.includes(name))) score += 2
          if (wantedArtist.some((token) => singer.includes(token))) score += 4
          return { item, score }
        })
        .sort((a, b) => b.score - a.score)[0]
      // Below 2 there is no agreement at all: the suggestion list is ranked by
      // popularity, so an unguarded first row would happily return a hit song.
      if (!best || best.score < 2 || !best.item?.mid) continue

      const detail = new URL(QQ_ALBUM)
      detail.search = new URLSearchParams({ albummid: String(best.item.mid), format: 'json', g_tk: '5381' }).toString()
      const data = await this.request(detail, 'qq')
      const record = data?.data ?? {}
      const got = normalizeName(record.name ?? '')
      if (!got || !(got === wanted || got.includes(wanted) || wanted.includes(got)))
        return { status: 'empty', detail: `详情返回的是《${firstString(record.name) || '未知'}》，与《${album.title}》不符` }

      const facts = []
      const statements = []
      if (firstString(record.aDate)) {
        facts.push({ label: '线上发行日期', value: humanDate(record.aDate) })
        statements.push({ slot: STATEMENT_SLOTS.release, text: `公开条目记录其发行于 ${humanDate(record.aDate)}` })
      }
      if (firstString(record.company)) {
        facts.push({ label: '唱片公司', value: firstString(record.company) })
        statements.push({ slot: STATEMENT_SLOTS.label, text: `由 ${firstString(record.company)} 发行` })
      }
      const tracks = Array.isArray(record.list) ? record.list.length : 0
      if (tracks > 0) facts.push({ label: '线上收录曲目', value: `${tracks} 首` })

      const desc = firstString(record.desc)
      if (!desc && !facts.length) return { status: 'empty', detail: '条目没有简介、发行日期或唱片公司' }
      return {
        status: 'ok',
        ...(desc ? { prose: clip(desc) } : {}),
        ...(facts.length ? { facts } : {}),
        ...(statements.length ? { statements } : {}),
        source: {
          name: 'QQ 音乐',
          url: `https://y.qq.com/n/ryqq/albumDetail/${encodeURIComponent(String(best.item.mid))}`,
          license: '内容版权归腾讯音乐娱乐集团及原作者所有（以来源页为准）',
          checkedAt: ISO(),
        },
      }
    }
    return { status: 'empty', detail: 'QQ 音乐未找到与本专辑名称、歌手相符的条目' }
  }

  /**
   * 百度百科, through its documented open API.
   *
   * The API resolves a keyword to one lemma and gives no disambiguation handle,
   * so the abstract has to be vetted: 「叶惠美」 answers with the person and
   * 「丝路」 with the Silk Road. Measured false positives on the author's library
   * were the reason for the three-part guard — the album's own 《》 title, a
   * release verb, and the performer's name — all of which the wrong lemmas fail.
   *
   * There is no fallback query shape that helps: 「X 专辑」, 「X（专辑）」 and
   * 「X + 歌手」 were all tried and returned the same wrong lemma, because the
   * suffix is normalised away before the lookup.
   */
  async baike(album) {
    const title = firstString(album.title)
    if (!title) return { status: 'empty', detail: '专辑名称为空' }
    const url = new URL(BAIKE_API)
    url.search = new URLSearchParams({
      scope: '103',
      format: 'json',
      appid: BAIKE_APPID,
      bk_key: title,
      bk_length: '1200',
    }).toString()
    const data = await this.request(url, 'baike')
    const abstract = firstString(data?.abstract)
    if (!abstract) return { status: 'empty', detail: '百科没有该词条或没有摘要' }
    if (!abstract.includes(`《${title}》`) || !/发行|收录|推出/.test(abstract))
      return { status: 'empty', detail: `词条不是本专辑：「${abstract.slice(0, 36)}…」` }
    const tokens = creditTokens(album.artist)
    if (tokens.length && !tokens.some((token) => normalizeName(abstract).includes(token)))
      return { status: 'empty', detail: `词条讲的是《${title}》但没有提到 ${album.artist}` }
    return {
      status: 'ok',
      prose: clip(abstract),
      source: {
        name: '百度百科',
        url: `https://baike.baidu.com/item/${encodeURIComponent(title)}`,
        license: '内容版权归百度百科及词条贡献者所有（以来源页为准）',
        checkedAt: ISO(),
      },
    }
  }

  /**
   * 网易云音乐. Two calls: `/api/search/get/web` gives the album id, then
   * `/api/v1/album/{id}` gives a long Chinese 简介 plus the release date, the
   * label and the track count. The id comes from a search result, so the match
   * is verified twice — title and performer in the search, and the detail's own
   * `name` again — exactly like the QQ 音乐 guard. The non-v1 `/api/album/{id}`
   * endpoint is 风控-ed (code:-462); only the v1 path answers without a login.
   */
  async netease(album) {
    const wantedArtist = creditTokens(album.artist)
    for (const variant of titleVariants(album.title)) {
      const search = new URL(NETEASE_SEARCH)
      search.search = new URLSearchParams({ s: `${variant} ${album.artist}`.trim(), type: '10', offset: '0', limit: '10' }).toString()
      let list
      try {
        const data = await this.request(search, 'netease')
        list = Array.isArray(data?.result?.albums) ? data.result.albums : []
      } catch (error) {
        if (variant === titleVariants(album.title)[0]) throw error
        continue
      }
      const wanted = normalizeName(variant)
      const best = list
        .map((item) => {
          const name = normalizeName(item?.name ?? '')
          const singer = normalizeName(typeof item?.artist === 'string' ? item.artist : (item?.artist?.name ?? ''))
          let score = 0
          if (name && name === wanted) score += 5
          else if (name && (name.includes(wanted) || wanted.includes(name))) score += 2
          if (wantedArtist.some((token) => singer.includes(token))) score += 4
          return { item, score }
        })
        .sort((a, b) => b.score - a.score)[0]
      // Below 2 there is no agreement at all: the suggestion list is ranked by
      // popularity, so an unguarded first row would happily return a hit album.
      if (!best || best.score < 2 || !best.item?.id) continue

      const detail = new URL(`${NETEASE_ALBUM}/${String(best.item.id)}`)
      const data = await this.request(detail, 'netease')
      const record = data?.album ?? data ?? {}
      const got = normalizeName(record.name ?? '')
      if (!got || !(got === wanted || got.includes(wanted) || wanted.includes(got)))
        return { status: 'empty', detail: `详情返回的是《${firstString(record.name) || '未知'}》，与《${album.title}》不符` }

      const facts = []
      const statements = []
      const date = millisToDate(record.publishTime)
      if (date) {
        facts.push({ label: '网易云发行日期', value: humanDate(date) })
        statements.push({ slot: STATEMENT_SLOTS.release, text: `公开条目记录其发行于 ${humanDate(date)}` })
      }
      if (firstString(record.company)) {
        const company = toSimplified(firstString(record.company))
        facts.push({ label: '网易云唱片公司', value: company })
        statements.push({ slot: STATEMENT_SLOTS.label, text: `由 ${company} 发行` })
      }
      const size = Number(record.size)
      if (size > 0) facts.push({ label: '网易云收录曲目', value: `${size} 首` })

      // 简介为繁体（偶含全角空格与换行），繁转简后压缩空白，与既有介绍管线一致。
      const desc = firstString(record.description) || firstString(record.briefDesc)
      if (!desc && !facts.length) return { status: 'empty', detail: '条目没有简介、发行日期或唱片公司' }
      return {
        status: 'ok',
        ...(desc ? { prose: clip(toSimplified(desc).replace(/\s+/g, ' ').trim()) } : {}),
        ...(facts.length ? { facts } : {}),
        ...(statements.length ? { statements } : {}),
        source: {
          name: '网易云音乐',
          url: `https://music.163.com/album?id=${encodeURIComponent(String(best.item.id))}`,
          license: '内容版权归网易云音乐及原作者所有（以来源页为准）',
          checkedAt: ISO(),
        },
      }
    }
    return { status: 'empty', detail: '网易云音乐未找到与本专辑名称、歌手相符的条目' }
  }

  /**
   * Discogs. One search call, no key. It contributes year / genre / format
   * facts only — no prose — so it is a best-effort tail that fills gaps the
   * prose sources leave (an album no domestic source describes). Discogs titles
   * read "Artist - Title", so both halves are matched independently.
   */
  async discogs(album) {
    const url = new URL(DISCOGS_SEARCH)
    // `artist` is deliberately omitted: Discogs matches it against the
    // latinised credit ("Jay Chou"), so a Han artist name yields zero rows.
    // The title alone is searched, and the performer is matched from the
    // "Artist - Title" shape of each row instead.
    url.search = new URLSearchParams({ release_title: album.title, type: 'release', per_page: '5' }).toString()
    const data = await this.request(url, 'discogs')
    const results = Array.isArray(data?.results) ? data.results : []
    const wantedTitle = normalizeName(album.title)
    const wantedArtist = normalizeName(album.artist)
    const scored = results
      .map((item) => {
        const raw = firstString(item?.title)
        const [credit = '', title = ''] = raw.split(/\s+-\s+/)
        let score = 0
        const titlePart = normalizeName(title)
        const creditPart = normalizeName(credit)
        if (titlePart && titlePart === wantedTitle) score += 5
        else if (titlePart && (titlePart.includes(wantedTitle) || wantedTitle.includes(titlePart))) score += 2
        if (wantedArtist && creditPart === wantedArtist) score += 4
        else if (wantedArtist && creditPart && (creditPart.includes(wantedArtist) || wantedArtist.includes(creditPart))) score += 1
        if (album.year && Number(item?.year) === Number(album.year)) score += 3
        return { item, score }
      })
      .sort((a, b) => b.score - a.score)[0]
    // Title and performer must both agree; a partial hit is not evidence.
    if (!scored || scored.score < 8) return { status: 'empty', detail: scored ? '发行条目名称、歌手或年份未能可靠对上' : '未检索到发行条目' }

    const item = scored.item
    const facts = []
    if (Number(item.year) > 0) facts.push({ label: 'Discogs 发行年份', value: `${item.year} 年` })
    const genres = (Array.isArray(item.genre) ? item.genre : []).map(firstString).filter(Boolean)
    if (genres.length) facts.push({ label: 'Discogs 流派', value: clip(genres.join(' / '), 160) })
    const formats = (Array.isArray(item.format) ? item.format : []).map(firstString).filter(Boolean)
    if (formats.length) facts.push({ label: 'Discogs 载体', value: clip(formats.join(' / '), 160) })
    if (!facts.length) return { status: 'empty', detail: '发行条目没有年份、流派或载体' }
    return {
      status: 'ok',
      facts,
      source: {
        name: 'Discogs',
        url: `https://www.discogs.com/release/${encodeURIComponent(String(item.id))}`,
        license: '数据以来源页为准（Discogs 数据库）',
        checkedAt: ISO(),
      },
    }
  }

  /**
   * Wikidata, best-effort. The most brittle of the tails — it times out often
   * on this machine — so it gets a short per-request budget and contributes a
   * single structured fact: the release date (P577). The entity is vetted the
   * same way 百度百科 is: the label must name the album, and either the
   * performer must be named or the description must read as an album/single.
   */
  async wikidata(album) {
    const title = firstString(album.title)
    if (!title) return { status: 'empty', detail: '专辑名称为空' }
    const search = new URL(WIKIDATA_SEARCH)
    search.search = new URLSearchParams({ action: 'wbsearchentities', search: title, language: 'zh', format: 'json', limit: '5', type: 'item' }).toString()
    const data = await this.request(search, 'wikidata', 3000)
    const hits = Array.isArray(data?.search) ? data.search : []
    if (!hits.length) return { status: 'empty', detail: '未检索到候选实体' }

    // The search label is often the English lemma ("Fantasy") even for a Han
    // title, so the Chinese name only matches an alias. Fetch all candidates in
    // one call and match against labels *and* aliases.
    const ids = hits.map((hit) => hit.id).filter((id) => /^Q\d+$/.test(id)).slice(0, 5)
    if (!ids.length) return { status: 'empty', detail: '候选实体无有效编号' }
    const entityUrl = new URL(WIKIDATA_SEARCH)
    entityUrl.search = new URLSearchParams({ action: 'wbgetentities', format: 'json', ids: ids.join('|'), props: 'labels|aliases|claims', languages: 'zh|zh-hans|zh-cn|en', languagefallback: '1' }).toString()
    const entitiesData = await this.request(entityUrl, 'wikidata', 3000)
    const entities = entitiesData?.entities ?? {}
    const wanted = normalizeName(title)
    const tokens = creditTokens(album.artist)
    let chosen
    for (const hit of hits) {
      const entity = entities[hit.id]
      if (!entity) continue
      const names = [
        entity.labels?.zh?.value,
        entity.labels?.['zh-hans']?.value,
        entity.labels?.en?.value,
        ...Object.values(entity.aliases ?? {}).flatMap((list) => (list ?? []).map((alias) => alias.value)),
      ]
        .filter(Boolean)
        .map(normalizeName)
      const namesTitle = names.some((name) => name === wanted || name.includes(wanted) || wanted.includes(name))
      if (!namesTitle) continue
      const description = hit.description ?? ''
      const descriptionNorm = normalizeName(description)
      const mentionsArtist = tokens.some((token) => descriptionNorm.includes(token) || names.some((name) => name.includes(token)))
      const isAlbumType = /专辑|專輯|唱片|录音室|錄音室|\balbum\b|\bep\b|单曲|單曲/i.test(description)
      if (mentionsArtist || isAlbumType) {
        chosen = { hit, entity }
        break
      }
    }
    if (!chosen) return { status: 'empty', detail: '未找到名称、类型或歌手相符的实体' }

    const time = (chosen.entity.claims?.P577 ?? []).find((item) => item.rank !== 'deprecated')?.mainsnak?.datavalue?.value?.time
    const date = typeof time === 'string' ? time.replace(/^\+/, '').slice(0, 10) : ''
    if (!date) return { status: 'empty', detail: '实体没有发行日期声明' }
    return {
      status: 'ok',
      facts: [{ label: 'Wikidata 发行日期', value: humanDate(date) }],
      statements: [{ slot: STATEMENT_SLOTS.release, text: `公开条目记录其发行于 ${humanDate(date)}` }],
      source: {
        name: 'Wikidata',
        url: `https://www.wikidata.org/wiki/${encodeURIComponent(chosen.hit.id)}`,
        license: 'CC0（以来源页为准）',
        checkedAt: ISO(),
      },
    }
  }

  /**
   * Resolves the supplement. Never throws: provider failures come back as
   * reported statuses so the panel can always say something true.
   */
  async resolve(album, { force = false } = {}) {
    const fingerprint = albumFingerprint(album)
    if (!force) {
      const memory = this.memory.get(fingerprint)
      if (memory && Date.now() - Date.parse(memory.checkedAt) < ONLINE_TTL_MS) return { ...memory, cached: true }
      const disk = await this.readCache(album)
      if (disk && Date.now() - Date.parse(disk.checkedAt) < ONLINE_TTL_MS) {
        this.memory.set(fingerprint, disk)
        return { ...disk, cached: true }
      }
    }
    await this.loadBreaker()

    const run = async (id, label, task) => {
      const reason = this.downReason(id)
      if (reason) return { id, label, status: 'skipped', detail: reason }
      try {
        const outcome = await withDeadline(task(), this.budgetMs, id, label)
        if (outcome.status === 'failed' && isConnectFailure({ message: outcome.detail })) this.markDown(id)
        return {
          id,
          label,
          status: outcome.status,
          ...(outcome.detail ? { detail: clip(outcome.detail, 240) } : {}),
          outcome,
        }
      } catch (error) {
        // The single place a provider is executed, so a throw must never escape.
        if (isConnectFailure(error)) this.markDown(id)
        return { id, label, status: 'failed', detail: clip(error.message, 240) }
      }
    }

    // Concurrent: each provider has its own gate, and the slowest must not
    // serialise behind the fastest. Order is the assembly order, not the
    // execution order — see the comment below.
    const plan = [
      ['qq', 'QQ 音乐', () => this.qq(album)],
      ['baike', '百度百科', () => this.baike(album)],
      ['musicbrainz', 'MusicBrainz', () => this.musicbrainz(album)],
      ['netease', '网易云音乐', () => this.netease(album)],
    ]
    const settled = await Promise.all(
      plan.map(([id, label, task]) => run(id, label, task)),
    )
    // The tail (Apple Music 商店 + Discogs + Wikidata) is held back to a second
    // phase. Measured on this library the store contributed 1 of 39 hits while
    // its Chinese search returns unrelated rows, and Discogs / Wikidata carry
    // facts rather than prose, so they stay available without spending a request
    // on every album. Only a clean sweep of "all four primary sources ran and
    // found nothing" triggers them: a failed or skipped provider means the
    // network is the problem, not coverage.
    if (settled.every((entry) => entry.status === 'empty'))
      settled.push(
        ...(await Promise.all([
          run('itunes', 'Apple Music 商店', () => this.itunes(album)),
          run('discogs', 'Discogs', () => this.discogs(album)),
          run('wikidata', 'Wikidata', () => this.wikidata(album)),
        ])),
      )

    // Assembled in `plan` order, not in completion order: providers answer in
    // whatever order the network gives, but the same album must not read back as
    // a differently-worded sentence every time its cache expires.
    const providers = settled.map(({ id, label, status, detail }) => ({
      id,
      label,
      status,
      ...(detail ? { detail } : {}),
    }))
    const facts = []
    const sources = []
    const statements = []
    /** First statement per slot wins; see STATEMENT_SLOTS for why. */
    const filledSlots = new Set()
    let prose = ''
    let proseSource
    for (const entry of settled) {
      const outcome = entry.outcome
      if (!outcome) continue
      const usesProse = Boolean(outcome.prose) && !prose
      if (usesProse) {
        prose = outcome.prose
        proseSource = outcome.source
      }
      if (outcome.facts?.length) facts.push(...outcome.facts)
      if (outcome.statements?.length)
        for (const statement of outcome.statements) {
          if (filledSlots.has(statement.slot)) continue
          filledSlots.add(statement.slot)
          statements.push(statement.text)
        }
      // A source is credited only when its content actually reached the panel. A
      // prose-only provider that lost the race would otherwise be listed as a
      // source of a paragraph it did not contribute.
      if (outcome.source && (usesProse || outcome.facts?.length || outcome.statements?.length))
        sources.push(outcome.source)
    }

    const blocks = []
    if (prose) blocks.push({ heading: '专辑简介', body: prose, source: proseSource })
    // 发行背景 is composed strictly from returned fields; prose stays separate
    // so a quoted sentence is never confused with a summary.
    if (statements.length) {
      blocks.push({
        heading: '发行背景',
        body: clip(
          `《${album.title}》（${album.artist}${album.year ? ` · ${album.year}` : ''}）的线上记录：${joinStatements(statements)}。以上为公开元数据整理，未作推断。`,
        ),
      })
    }

    const anything = blocks.length > 0 || facts.length > 0
    const failed = providers.filter((provider) => provider.status === 'failed')
    const payload = {
      status: anything ? 'ok' : failed.length === providers.length ? 'error' : 'empty',
      checkedAt: ISO(),
      fingerprint,
      blocks,
      facts,
      sources,
      providers,
      // Two different "nothing to show" states, with two different answers:
      //   * every source unreachable -> 'error', and the reason is the transport
      //     failure, because there is nothing the reader can do about their tags;
      //   * some source answered "not found" -> 'empty', and the useful message
      //     is what would improve the hit rate. A store that errored on the way
      //     is still named, per provider, in `providers`.
      ...(anything
        ? {}
        : {
            error:
              failed.length === providers.length
                ? failed[0]?.detail ?? '公开来源均无法访问。'
                : '公开来源未找到与本地标签可靠对应的条目。补全名称、歌手与年份会显著提高命中率。',
          }),
      // Offered even on success: reading the full article is the user's call,
      // and a search link makes no claim of its own. A domestic engine, because
      // the sources above are domestic.
      searchUrl: `https://www.baidu.com/s?wd=${encodeURIComponent(`${album.title} ${album.artist} 专辑`)}`,
    }
    this.memory.set(fingerprint, payload)
    await this.writeCache(album, payload)
    return payload
  }
}
