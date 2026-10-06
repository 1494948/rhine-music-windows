import { PROVIDER_HOSTS } from './album-online.mjs'

/**
 * Reachability self-check for the online supplement sources.
 *
 * Unlike `check-music-online.mjs` (which injects a fetcher and is fully
 * offline), this script talks to the real network with Node's built-in fetch —
 * undici reads no `http_proxy`, so the probe sees the same route a user's
 * broadband does. It reports one row per host: HTTP status, elapsed ms and
 * whether the body parsed as JSON. The idea is that a source going down should
 * be discovered by running `check:music`, not by the user opening a detail page.
 *
 * It is a report, not a verdict: a host being down is an environment fact, not a
 * code defect, so it always exits 0. Run `--fail-on-error` to make any failed
 * host non-zero (useful in a cron).
 */

const APP_UA = 'RhineLocalMusic/0.3 (personal local music library; metadata display only)'

/** One representative endpoint per provider, keyed by the resolver's gate id. */
const PROBES = [
  {
    id: 'qq',
    label: 'QQ 音乐',
    build: () => {
      const url = new URL('https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg')
      url.search = new URLSearchParams({ key: '范特西', format: 'json', g_tk: '5381' }).toString()
      return url
    },
  },
  {
    id: 'baike',
    label: '百度百科',
    build: () => {
      const url = new URL('https://baike.baidu.com/api/openapi/BaikeLemmaCardApi')
      url.search = new URLSearchParams({ scope: '103', format: 'json', appid: '379020', bk_key: '范特西', bk_length: '100' }).toString()
      return url
    },
  },
  {
    id: 'musicbrainz',
    label: 'MusicBrainz',
    build: () => {
      const url = new URL('https://musicbrainz.org/ws/2/release-group')
      url.search = new URLSearchParams({ query: 'releasegroup:"范特西"', fmt: 'json', limit: '1' }).toString()
      return url
    },
  },
  {
    id: 'netease',
    label: '网易云音乐',
    build: () => {
      const url = new URL('https://music.163.com/api/search/get/web')
      url.search = new URLSearchParams({ s: '范特西', type: '10', limit: '1' }).toString()
      return url
    },
  },
  {
    id: 'discogs',
    label: 'Discogs',
    build: () => {
      const url = new URL('https://api.discogs.com/database/search')
      url.search = new URLSearchParams({ release_title: '范特西', type: 'release', per_page: '1' }).toString()
      return url
    },
  },
  {
    id: 'itunes',
    label: 'Apple Music',
    build: () => {
      const url = new URL('https://itunes.apple.com/search')
      url.search = new URLSearchParams({ term: '范特西', entity: 'album', limit: '1' }).toString()
      return url
    },
  },
  {
    id: 'wikidata',
    label: 'Wikidata',
    build: () => {
      const url = new URL('https://www.wikidata.org/w/api.php')
      url.search = new URLSearchParams({ action: 'wbsearchentities', search: '范特西', language: 'zh', format: 'json', limit: '1' }).toString()
      return url
    },
  },
]

async function probe({ id, label, build }) {
  const url = build()
  const start = Date.now()
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': APP_UA },
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    })
    const text = await response.text()
    const ms = Date.now() - start
    let isJson = false
    try {
      JSON.parse(text)
      isJson = true
    } catch {
      /* not JSON */
    }
    const ok = response.ok && isJson
    return { id, label, host: url.hostname, ok, status: response.status, ms, isJson }
  } catch (error) {
    return { id, label, host: url.hostname, ok: false, status: 0, ms: Date.now() - start, isJson: false, error: error?.cause?.message ?? error.message }
  }
}

const results = await Promise.all(PROBES.map(probe))
const failed = results.filter((row) => !row.ok)

console.log('check-music-online-sources: reachability report (Node fetch, no proxy)')
console.log('主机'.padEnd(16), '状态'.padEnd(6), '耗时'.padEnd(9), 'JSON')
for (const row of results) {
  const state = row.ok ? 'OK' : 'FAIL'
  const detail = row.ok ? '' : ` (${row.error ?? `HTTP ${row.status}`})`
  console.log(
    `${row.label.padEnd(14)}`.padEnd(16),
    state.padEnd(6),
    `${String(row.ms).padEnd(4)} ms`.padEnd(9),
    row.isJson ? 'yes' : 'no',
    detail,
  )
}
console.log(`汇总：${results.length - failed.length}/${results.length} 可达`)

// The host whitelist must stay in sync with the resolver's — a probe whose id
// is not in PROVIDER_HOSTS is a bug in this script, not a network fact.
for (const row of results) {
  if (!Object.hasOwn(PROVIDER_HOSTS, row.id)) {
    console.error(`探针 ${row.id} 不在 PROVIDER_HOSTS 白名单内`)
    process.exitCode = 1
  }
}

if (process.argv.includes('--fail-on-error') && failed.length) process.exitCode = 1
