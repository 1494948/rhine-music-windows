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
import { AlbumIntroductionProvider, normalizeName } from './album-introductions.mjs'

export const ONLINE_TTL_MS = 30 * 86400_000
export const MAX_BLOCK_BYTES = 4000
/** Whole-lookup budget. Providers that miss it are reported, never awaited. */
export const OVERALL_BUDGET_MS = 12_000
/** How long a host stays out of rotation after a connect-level failure. */
export const BREAKER_MS = 30 * 60_000

const APP_UA = 'RhineLocalMusic/0.3 (personal local music library; metadata display only)'
const ISO = () => new Date().toISOString()

/** Hosts we are willing to talk to, for documentation and validation. */
export const PROVIDER_HOSTS = {
  musicbrainz: 'musicbrainz.org',
  itunes: 'itunes.apple.com',
  wikipedia: 'wikipedia.org',
}

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

/** Resolves to a provider outcome once the limit passes, without cancelling. */
function withDeadline(promise, ms, id, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'failed', detail: `超出 ${Math.round(ms / 1000)} 秒预算，已放弃` , id, label }), ms)),
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
 * `fetcher`, `introProvider` and `clock` are injectable so the check script can
 * drive every branch without touching the real network.
 */
export class AlbumOnlineResolver {
  constructor({
    dataDir,
    fetcher = globalThis.fetch,
    intervalMs = 1100,
    requestTimeoutMs = 6000,
    wikiTimeoutMs = 2500,
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
      musicbrainz: new Gate(intervalMs),
      itunes: new Gate(intervalMs),
      wikipedia: new Gate(intervalMs),
    }
    // A short timeout is deliberate here: a reachable Wikipedia answers in well
    // under a second, so anything slower is a network problem, not patience.
    this.intro = new AlbumIntroductionProvider({ fetcher, intervalMs, timeoutMs: wikiTimeoutMs, contact: () => this.contact })
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

  async request(url, gateId) {
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
            signal: AbortSignal.timeout(this.requestTimeoutMs),
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
      statements.push(`公开条目记录其首次发行于 ${humanDate(firstDate)}`)
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
        statements.push(`商店记录的上架日期为 ${humanDate(item.releaseDate)}`)
      }
      if (item.primaryGenreName) {
        facts.push({ label: '商店流派', value: item.primaryGenreName })
        statements.push(`商店归类为 ${item.primaryGenreName}`)
      }
      if (Number(item.trackCount) > 0) {
        facts.push({ label: '商店收录曲目', value: `${item.trackCount} 首` })
        statements.push(`商店记录收录 ${item.trackCount} 首曲目`)
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

  /** Wikipedia prose. The only real prose source, and strictly best-effort. */
  async wikipedia(album) {
    let result
    try {
      result = await this.intro.lookup({ title: album.title, artist: album.artist, year: album.year })
    } catch (error) {
      throw error
    }
    if (result?.status === 'matched' && result.description && result.descriptionSource?.url) {
      return {
        status: 'ok',
        prose: clip(result.description),
        source: {
          name: result.descriptionSource.name ?? '维基百科',
          url: result.descriptionSource.url,
          license: result.descriptionSource.license ?? 'CC BY-SA（以来源页为准）',
          checkedAt: result.descriptionSource.checkedAt ?? ISO(),
        },
      }
    }
    if (result?.status === 'uncertain') return { status: 'empty', detail: result.error ?? '存在多个候选条目，未自动采用' }
    if (result?.status === 'error') throw new Error(result.error ?? '来源无法访问')
    return { status: 'empty', detail: '未找到对应条目' }
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

    // Concurrent: each provider has its own gate, and the slow one (Wikipedia on
    // a broken network) must not serialise behind the fast ones.
    const plan = [
      ['musicbrainz', 'MusicBrainz', () => this.musicbrainz(album)],
      ['itunes', 'Apple Music 商店', () => this.itunes(album)],
      ['wikipedia', '维基百科', () => this.wikipedia(album)],
    ]
    const settled = await Promise.all(
      plan.map(([id, label, task]) => run(id, label, task)),
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
    let prose = ''
    let proseSource
    for (const entry of settled) {
      const outcome = entry.outcome
      if (!outcome) continue
      if (outcome.facts?.length) facts.push(...outcome.facts)
      if (outcome.source) sources.push(outcome.source)
      if (outcome.statements?.length) statements.push(...outcome.statements)
      if (outcome.prose && !prose) {
        prose = outcome.prose
        proseSource = outcome.source
      }
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
      ...(anything
        ? {}
        : { error: failed[0]?.detail ?? '公开来源未找到与本地标签可靠对应的条目。补全名称、歌手与年份会显著提高命中率。' }),
      // Offered even on success: reading the full article is the user's call,
      // and a search link makes no claim of its own.
      searchUrl: `https://zh.wikipedia.org/w/index.php?search=${encodeURIComponent(`${album.title} ${album.artist}`)}`,
    }
    this.memory.set(fingerprint, payload)
    await this.writeCache(album, payload)
    return payload
  }
}
