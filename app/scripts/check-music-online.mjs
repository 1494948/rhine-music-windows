import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AlbumOnlineResolver,
  MAX_BLOCK_BYTES,
  ONLINE_TTL_MS,
  PROVIDER_HOSTS,
  albumFingerprint,
  titleVariants,
} from './album-online.mjs';

/**
 * Contract check for the online album supplement.
 *
 * The fetcher is injected, so every branch is reachable without a network:
 * agreement, near miss, a wrong suggestion mid, a wrong Baike lemma,
 * unreachable hosts, an overall deadline, a rate limit, a cache hit and TTL
 * expiry. Three promises are asserted hardest, because they are the ones a
 * reviewer cannot otherwise see:
 *
 *   1. Nothing is invented. A fact may only carry a label this module produces
 *      itself, prose only ever comes from a quoted source, and every adopted
 *      source carries a licence and a URL.
 *   2. A wrong answer is rejected, not smoothed over. Both domestic sources
 *      return a confidently wrong record for an ambiguous album name — QQ 音乐
 *      hands back a different album's mid, 百度百科 a different lemma — so both
 *      guards are driven here with the wrong payload.
 *   3. A dead host is not re-asked. One connect failure must take that provider
 *      out of rotation and persist the decision, or a black-holed DNS entry
 *      costs every album in the library a full timeout.
 */

/** Every fact label the module is allowed to emit. */
const FACT_LABELS = new Set([
  '线上专辑类型',
  '线上首次发行',
  '年份差异',
  '线上匹配度',
  '线上发行日期',
  '唱片公司',
  '线上收录曲目',
  '商店发行日期',
  '商店流派',
  '商店收录曲目',
  '版权声明',
  '网易云发行日期',
  '网易云唱片公司',
  '网易云收录曲目',
  'Discogs 发行年份',
  'Discogs 流派',
  'Discogs 载体',
  'Wikidata 发行日期',
]);

const HIT = { id: 'album-aaaa1111', title: '测试专辑', artist: '测试歌手', year: 2025 };
const OFF_YEAR = { id: 'album-cccc3333', title: '测试专辑', artist: '测试歌手', year: 2001 };
const NEAR_MISS = { id: 'album-bbbb2222', title: '另一个专辑', artist: '别的歌手', year: 1997 };

const PROSE = '《测试专辑》是测试歌手于 2025 年推出的第十张录音室专辑，共收录十首曲目，由制作人长期合作完成，被视作其创作阶段的总结。';

/** A fetch stand-in that routes by hostname and records every host it sees. */
function makeFetcher(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    const target = url instanceof URL ? url : new URL(String(url));
    calls.push(target.hostname);
    const route = routes[target.hostname];
    if (!route) throw new Error(`unexpected host ${target.hostname}`);
    const value = await route(target, init);
    if (value instanceof Error) throw value;
    // `{ __http: 503 }` stands in for a non-ok response.
    if (value && typeof value === 'object' && '__http' in value)
      return { ok: false, status: value.__http, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => value };
  };
  fetcher.calls = calls;
  return fetcher;
}

const MUSICBRAINZ_HIT = () => ({
  'release-groups': [
    {
      id: 'rg-1',
      title: '测试专辑',
      'artist-credit': [{ name: '测试歌手' }],
      'first-release-date': '2025-03-14',
      'primary-type': 'Album',
    },
    {
      id: 'rg-0',
      title: '无关专辑',
      'artist-credit': [{ name: '别人' }],
      'first-release-date': '1999-01-01',
      'primary-type': 'Single',
    },
  ],
});

/** No candidate agrees with the tag: a near-miss fixture, not an error. */
const MUSICBRAINZ_EMPTY = () => ({ 'release-groups': [] });

const ITUNES_HIT = () => ({
  results: [
    {
      collectionName: '测试专辑',
      artistName: '测试歌手',
      releaseDate: '2025-03-14T07:00:00Z',
      primaryGenreName: '流行',
      trackCount: 10,
      collectionViewUrl: 'https://music.apple.com/cn/album/1',
      copyright: '℗ 2025 某唱片',
    },
  ],
});

/**
 * QQ 音乐's two endpoints live on one host, so the route branches on the path.
 * `detail` is what the album endpoint answers — the seam the wrong-mid guard is
 * driven through.
 */
function qqHost({
  name = '测试专辑',
  song = '测试歌手',
  mid = 'mid-1',
  detail = { name: '测试专辑', aDate: '2025-03-14', company: '测试唱片', desc: PROSE, list: Array.from({ length: 10 }, (_, i) => i + 1) },
  suggest = { name, singer: [song], mid },
} = {}) {
  return (target) => {
    if (target.pathname.endsWith('smartbox_new.fcg'))
      return { data: { album: { itemlist: Array.isArray(suggest) ? suggest : [suggest] } } };
    if (target.pathname.endsWith('fcg_v8_album_info_cp.fcg')) return { data: detail };
    return { __http: 404 };
  };
}

/**
 * 网易云's two endpoints live on one host, so the route branches on the path.
 * `detail` is the album endpoint's answer — the seam the wrong-id guard is
 * driven through, mirroring QQ 音乐's wrong-mid guard.
 */
function neteaseHost({
  name = '测试专辑',
  artist = '测试歌手',
  id = 'netease-1',
  detail = { name: '测试专辑', publishTime: Date.parse('2025-03-14T00:00:00Z'), company: '测试唱片', size: 10, description: '《测试专辑》是测试歌手推出的第十张录音室专辑。' },
  suggest = [{ id, name, artist: { name: artist } }],
} = {}) {
  return (target) => {
    if (target.pathname.endsWith('search/get/web'))
      return { result: { albums: Array.isArray(suggest) ? suggest : [suggest] } };
    if (/\/api\/v1\/album\/[\w-]+$/.test(target.pathname)) return { album: detail };
    return { __http: 404 };
  };
}

/** Discogs answers with a flat results list; title reads "Artist - Title". */
function discogsHost({ title = '测试歌手 - 测试专辑', year = 2025, genre = ['流行'], format = ['CD', 'Album'], id = 'd-1' } = {}) {
  return () => ({ results: [{ title, year, genre, format, id }] });
}

/** Wikidata branches on the MediaWiki `action` parameter. */
function wikidataHost({
  search = [{ id: 'Q123', label: '测试专辑', description: '测试歌手发行的专辑' }],
  entity = { claims: { P577: [{ rank: 'normal', mainsnak: { datavalue: { value: { time: '+2025-03-14T00:00:00Z' } } } }] }, labels: { zh: { value: '测试专辑' } }, aliases: {} },
} = {}) {
  return (target) => {
    if (target.searchParams.get('action') === 'wbsearchentities') return { search: Array.isArray(search) ? search : [search] };
    if (target.searchParams.get('action') === 'wbgetentities') {
      const id = String(target.searchParams.get('ids') ?? 'Q123').split('|')[0];
      return { entities: { [id]: entity } };
    }
    return { __http: 404 };
  };
}

/** The store answered, but carries nothing for this album. */
const ITUNES_EMPTY = () => ({ results: [] });

/** 百度百科 answers with one lemma and no disambiguation handle. */
const baikeHost = (abstract = PROSE) => () => ({ abstract });

/** Both endpoint sets miss cleanly: nothing was found, nothing errored. */
const qqEmpty = () => qqHost({ suggest: [] });
const baikeEmpty = () => baikeHost('');

/** Every host the module is allowed to talk to. No host outside this list. */
const ALLOWED_HOSTS = new Set(Object.values(PROVIDER_HOSTS));
const HOST_ALLOWED = (host) => ALLOWED_HOSTS.has(host);

/** Waits for a condition instead of guessing at a fixed sleep. */
async function waitFor(predicate, ms = 1500) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-'));
const downDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-down-'));
const slowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-slow-'));

try {
  // ---------------------------------------------------------------- 命中与装配
  {
    const fetcher = makeFetcher({
      'c.y.qq.com': qqHost(),
      'baike.baidu.com': baikeHost(),
      'musicbrainz.org': MUSICBRAINZ_HIT,
      'music.163.com': neteaseHost(),
      'itunes.apple.com': ITUNES_HIT,
    });
    const resolver = new AlbumOnlineResolver({ dataDir, fetcher, intervalMs: 0 });

    const payload = await resolver.resolve(HIT);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.fingerprint, albumFingerprint(HIT));
    assert.ok(payload.checkedAt, 'a payload always records when it was checked');

    // Only the safe hosts were contacted, and the store was left alone: a
    // domestic source answered, so no request is spent on Apple Music.
    const stray = [...new Set(fetcher.calls)].filter((host) => !HOST_ALLOWED(host));
    assert.deepEqual(stray, [], `unexpected host contacted: ${stray}`);
    assert.ok(
      !fetcher.calls.includes('itunes.apple.com'),
      'the store is not asked once a domestic source answered',
    );

    // Nothing invented: every label is one this module owns.
    assert.ok(payload.facts.length > 0);
    for (const fact of payload.facts) {
      assert.ok(FACT_LABELS.has(fact.label), `unowned fact label: ${fact.label}`);
      assert.ok(fact.value, `fact ${fact.label} carries no value`);
    }
    const labels = new Set(payload.facts.map((fact) => fact.label));
    for (const expected of ['线上发行日期', '唱片公司', '线上收录曲目', '线上专辑类型', '线上首次发行', '线上匹配度'])
      assert.ok(labels.has(expected), `missing fact ${expected}`);
    assert.equal(payload.facts.find((fact) => fact.label === '线上专辑类型').value, 'Album');

    // Only the sources whose content actually reached the panel are credited.
    // 百度百科 answered with a usable abstract but lost the prose race to QQ 音乐
    // (assembly order), so it must not be listed as a source of that paragraph.
    const names = payload.sources.map((source) => source.name).sort();
    assert.deepEqual(names, ['MusicBrainz', 'QQ 音乐', '网易云音乐']);
    for (const source of payload.sources) {
      assert.ok(source.url?.startsWith('https://'), `source ${source.name} has no https link`);
      assert.ok(source.license, `source ${source.name} has no licence`);
      assert.ok(source.checkedAt, `source ${source.name} has no checkedAt`);
    }

    // Each provider reports its own outcome, so the panel can be honest.
    assert.deepEqual(
      payload.providers.map((provider) => [provider.id, provider.status]),
      [
        ['qq', 'ok'],
        ['baike', 'ok'],
        ['musicbrainz', 'ok'],
        ['netease', 'ok'],
      ],
    );

    // The quoted paragraph is attributed to the provider that supplied it.
    const intro = payload.blocks.find((block) => block.heading === '专辑简介');
    assert.ok(intro, 'the quoted abstract becomes 专辑简介');
    assert.equal(intro.body, PROSE);
    assert.equal(intro.source.name, 'QQ 音乐');

    // The assembled sentence follows the provider order, not the completion
    // order, so the same album never reads back differently.
    const background = payload.blocks.find((block) => block.heading === '发行背景');
    assert.ok(background, 'a 发行背景 block is assembled from the returned fields');
    assert.ok(background.body.includes('公开条目记录其发行于 2025 年 3 月 14 日'));
    assert.ok(background.body.includes('由 测试唱片 发行'));
    // QQ 音乐 and MusicBrainz state the same release date. The sentence slot for
    // it is filled once, so the reader is not told the same date twice.
    assert.equal(
      background.body.split('2025 年 3 月 14 日').length - 1,
      1,
      'a release date stated by two sources is said once',
    );
    assert.ok(background.body.length <= MAX_BLOCK_BYTES + 64, 'a block is bounded in size');
    // 发行背景 is a summary, so it must not masquerade as a quoted source.
    assert.equal(background.source, undefined);

    // A disagreement between the tag and the source is reported, not smoothed over.
    const offYear = await resolver.resolve(OFF_YEAR);
    assert.equal(offYear.status, 'ok');
    assert.equal(
      offYear.facts.find((fact) => fact.label === '年份差异').value,
      '本地标签 2001 · 线上 2025',
    );

    // ------------------------------------------------------------ 缓存与 TTL
    const before = fetcher.calls.length;
    const cached = await resolver.resolve(HIT);
    assert.equal(cached.cached, true, 'a second read is served from memory');
    assert.equal(fetcher.calls.length, before, 'a cache hit issues no requests');

    const forced = await resolver.resolve(HIT, { force: true });
    assert.ok(fetcher.calls.length > before, 'force re-reads the sources');
    // A provider that never failed stays in rotation; only a connect failure
    // earns the breaker.
    assert.ok(
      forced.providers.every((provider) => provider.status === 'ok'),
      'a healthy provider is never taken out of rotation',
    );

    // A cache file is written beside the library data, keyed by album identity.
    const cacheFile = path.join(dataDir, 'album-online', `${HIT.id}.json`);
    const raw = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    assert.equal(raw.fingerprint, albumFingerprint(HIT));
    assert.equal(raw.providers.length, 4);

    // An expired entry is not served. A fresh resolver proves it is the disk
    // TTL, not the in-memory cache, that decides.
    raw.checkedAt = new Date(Date.now() - ONLINE_TTL_MS - 86_400_000).toISOString();
    raw.blocks = [{ heading: '陈旧', body: '不应被采用' }];
    await fs.writeFile(cacheFile, JSON.stringify(raw), 'utf8');
    const reopened = new AlbumOnlineResolver({ dataDir, fetcher, intervalMs: 0 });
    const refreshed = await reopened.resolve(HIT);
    assert.equal(refreshed.cached, undefined, 'an expired entry is not reported as a cache hit');
    assert.ok(
      !refreshed.blocks.some((block) => block.heading === '陈旧'),
      'an expired entry is not served',
    );
  }

  // ------------------------------------------------------------ 错答必须拒绝
  {
    // The domestic sources answer confidently and the answers are wrong:
    // QQ 音乐 suggests a mid whose album endpoint returns a different record,
    // 网易云 suggests an id whose v1 detail returns a different album, and
    // 百度百科 resolves the keyword to a lemma about something else. The near
    // miss must not be adopted, and the tail must not be credited either.
    const wrongDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-wrong-'));
    try {
      const fetcher = makeFetcher({
        'c.y.qq.com': qqHost({ detail: { name: '另一个专辑', aDate: '1999-01-01', company: '别的唱片', desc: '这是另一张专辑的简介。' } }),
        'baike.baidu.com': baikeHost('丝绸之路是古代连接中国与中亚、西亚以及欧洲的交通路线，其影响持续到近代。'),
        'musicbrainz.org': MUSICBRAINZ_EMPTY,
        'music.163.com': neteaseHost({ detail: { name: '另一个专辑', publishTime: Date.parse('1999-01-01T00:00:00Z'), company: '别的唱片', size: 5, description: '这是另一张专辑的简介。' } }),
        'itunes.apple.com': ITUNES_EMPTY,
        'api.discogs.com': discogsHost({ title: '别的歌手 - 另一个专辑', year: 1999 }),
        'www.wikidata.org': wikidataHost({ search: [] }),
      });
      const resolver = new AlbumOnlineResolver({ dataDir: wrongDir, fetcher, intervalMs: 0 });
      const payload = await resolver.resolve(HIT);

      assert.equal(payload.status, 'empty', 'a confirmed mismatch is empty, not a hit');
      assert.equal(payload.blocks.length, 0, 'a wrong record contributes no paragraph');
      assert.equal(payload.facts.length, 0, 'a wrong record contributes no field');
      assert.equal(payload.sources.length, 0, 'nothing adopted means nothing to attribute');
      assert.equal(typeof payload.error, 'string', 'an empty result explains itself');

      // The reasons are readable and name the offending record, so a user can
      // tell "the source had nothing" from "the source had the wrong thing".
      const qq = payload.providers.find((provider) => provider.id === 'qq');
      assert.match(qq.detail, /另一个专辑/, 'the mismatch names the album that came back');
      const netease = payload.providers.find((provider) => provider.id === 'netease');
      assert.match(netease.detail, /另一个专辑/, 'the wrong 网易云 detail is rejected by name');
      const baike = payload.providers.find((provider) => provider.id === 'baike');
      assert.match(baike.detail, /词条不是本专辑|没有提到/, 'the wrong lemma is rejected by name');

      // Nothing was adopted, so the tail *was* asked — and none of its rows
      // correspond to this album either.
      assert.ok(fetcher.calls.includes('itunes.apple.com'), 'the store gets its turn');
      assert.ok(fetcher.calls.includes('api.discogs.com'), 'Discogs gets its turn');
      assert.ok(fetcher.calls.includes('www.wikidata.org'), 'Wikidata gets its turn');
      assert.equal(payload.providers.length, 7);
      assert.equal(payload.providers.at(-1).id, 'wikidata');
    } finally {
      await fs.rm(wrongDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // -------------------------------------------------------- 近失不采用
  {
    const missDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-miss-'));
    try {
      const fetcher = makeFetcher({
        'c.y.qq.com': qqHost(),
        'baike.baidu.com': baikeHost(),
        'musicbrainz.org': MUSICBRAINZ_EMPTY,
        'music.163.com': neteaseHost(),
        'itunes.apple.com': ITUNES_HIT,
        'api.discogs.com': discogsHost(),
        'www.wikidata.org': wikidataHost(),
      });
      const resolver = new AlbumOnlineResolver({ dataDir: missDir, fetcher, intervalMs: 0 });
      const miss = await resolver.resolve(NEAR_MISS);
      assert.equal(miss.status, 'empty', 'a near miss is reported as empty, not as a hit');
      assert.equal(miss.blocks.length, 0);
      assert.equal(miss.facts.length, 0);
      assert.equal(miss.sources.length, 0, 'nothing adopted means nothing to attribute');
      assert.equal(typeof miss.error, 'string', 'an empty result explains itself');
      assert.equal(miss.searchUrl, `https://www.baidu.com/s?wd=${encodeURIComponent('另一个专辑 别的歌手 专辑')}`);
    } finally {
      await fs.rm(missDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ------------------------------------------------------------ 全部不可达
  {
    const refused = async (url) => {
      const host = (url instanceof URL ? url : new URL(String(url))).hostname;
      throw new Error(`connect ECONNREFUSED ${host}:443`);
    };
    const resolver = new AlbumOnlineResolver({ dataDir: downDir, fetcher: refused, intervalMs: 0 });
    const payload = await resolver.resolve(HIT);
    // Everything failed, so this is an error rather than an empty result: the
    // reader needs to know the difference between "not found" and "unreachable".
    assert.equal(payload.status, 'error');
    assert.ok(payload.providers.every((provider) => provider.status === 'failed'));
    assert.ok(payload.error, 'an error payload carries a reason');

    const breakerFile = path.join(downDir, 'album-online', '_breakers.json');
    assert.ok(
      await waitFor(async () => fs.readFile(breakerFile, 'utf8').then(() => true, () => false)),
      'the breaker is persisted so it survives a restart',
    );
    const breakers = JSON.parse(await fs.readFile(breakerFile, 'utf8'));
    // Only the four primary providers that were actually asked. The tail
    // (Apple Music / Discogs / Wikidata) is held back until all primary sources
    // come back empty, and an unreachable host is never "empty", so it earned no
    // breaker here.
    assert.deepEqual(Object.keys(breakers).sort(), ['baike', 'musicbrainz', 'netease', 'qq']);

    // A resolver restarted over the same data dir must not re-probe the hosts.
    let calls = 0;
    const counting = async () => {
      calls++;
      throw new Error('connect ECONNREFUSED');
    };
    const restarted = new AlbumOnlineResolver({ dataDir: downDir, fetcher: counting, intervalMs: 0 });
    const again = await restarted.resolve(NEAR_MISS);
    assert.equal(calls, 0, 'a host known to be down is not asked again');
    assert.ok(again.providers.every((provider) => provider.status === 'skipped'));
  }

  // -------------------------------------------------------------- 超时预算
  {
    // A host that accepts the request and then never answers. Without the
    // deadline this would hold the detail page open indefinitely.
    const hang = async () => new Promise(() => {});
    const resolver = new AlbumOnlineResolver({
      dataDir: slowDir,
      fetcher: hang,
      intervalMs: 0,
      budgetMs: 60,
    });
    const payload = await resolver.resolve(HIT);
    assert.equal(payload.status, 'error');
    assert.equal(payload.providers.length, 4);
    for (const provider of payload.providers) {
      assert.equal(provider.status, 'failed');
      assert.match(provider.detail, /预算/, 'a missed budget says so');
    }
    // A deadline is not a connect failure, so it must not trip the breaker.
    const breakerFile = path.join(slowDir, 'album-online', '_breakers.json');
    const exists = await fs.readFile(breakerFile, 'utf8').then(() => true, () => false);
    assert.equal(exists, false, 'a slow host is not marked down');
  }

  // -------------------------------------------------------------- 限流重试
  {
    const retryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-retry-'));
    try {
      // MusicBrainz documents 503 as "back off and retry", and a library-wide
      // pass is exactly the workload that trips it. One retry must happen, and
      // only one: an unbounded retry would turn a rate limit into a hammer.
      let attempts = 0;
      const flaky = makeFetcher({
        'c.y.qq.com': qqEmpty,
        'baike.baidu.com': baikeEmpty,
        'musicbrainz.org': () => {
          attempts++;
          return attempts === 1 ? { __http: 503 } : MUSICBRAINZ_HIT();
        },
        'music.163.com': neteaseHost({ suggest: [] }),
      });
      const resolver = new AlbumOnlineResolver({
        dataDir: retryDir,
        fetcher: flaky,
        intervalMs: 0,
        retryDelayMs: 5,
      });
      const payload = await resolver.resolve(HIT);
      assert.equal(payload.status, 'ok');
      const brainz = payload.providers.find((provider) => provider.id === 'musicbrainz');
      assert.equal(brainz.status, 'ok', 'a single 503 is retried');
      assert.equal(attempts, 2, 'the retry happens exactly once');
      assert.ok(
        !flaky.calls.includes('itunes.apple.com'),
        'one source answering is enough to skip the store',
      );
      assert.ok(
        !flaky.calls.includes('api.discogs.com') && !flaky.calls.includes('www.wikidata.org'),
        'one source answering is enough to skip the whole tail',
      );
    } finally {
      await fs.rm(retryDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ------------------------------------------- 商店失败不当作「没有收录」
  {
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-store-'));
    try {
      // All three domestic sources ran and found nothing, so the store is asked;
      // both storefronts then error. That is unreachable, not "not carried", and
      // the panel must not report "nothing found" for a store it never reached.
      let storeCalls = 0;
      const flaky = makeFetcher({
        'c.y.qq.com': qqEmpty,
        'baike.baidu.com': baikeEmpty,
        'musicbrainz.org': MUSICBRAINZ_EMPTY,
        'music.163.com': neteaseHost({ suggest: [] }),
        'itunes.apple.com': () => {
          storeCalls++;
          return { __http: 500 };
        },
        'api.discogs.com': discogsHost({ title: '别的歌手 - 另一个专辑', year: 1999 }),
        'www.wikidata.org': wikidataHost({ search: [] }),
      });
      const resolver = new AlbumOnlineResolver({ dataDir: storeDir, fetcher: flaky, intervalMs: 0 });
      const payload = await resolver.resolve(HIT);
      const store = payload.providers.find((provider) => provider.id === 'itunes');
      assert.equal(store.status, 'failed', 'a store that only ever errored is not "empty"');
      assert.match(store.detail, /HTTP 500/);
      assert.equal(storeCalls, 2, 'both storefronts were tried, and neither was retried');
      // The three domestic sources did answer, so this is "not found", not
      // "unreachable": the top-level message stays actionable and the store's
      // transport error stays where it belongs, against that provider.
      assert.equal(payload.status, 'empty');
      assert.match(payload.error, /补全名称、歌手与年份/, 'the reader gets something to act on');
    } finally {
      await fs.rm(storeDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ------------------------------------------------------------ 身份指纹
  {
    // Case, whitespace and punctuation are not identity; the year is.
    assert.equal(
      albumFingerprint({ title: 'A-B', artist: 'C D', year: 2025 }),
      albumFingerprint({ title: 'ab', artist: 'cd', year: '2025' }),
    );
    assert.notEqual(
      albumFingerprint({ title: 'A', artist: 'C', year: 2025 }),
      albumFingerprint({ title: 'A', artist: 'C', year: 2024 }),
    );
    // A missing year is a real difference: it must not collide with any year.
    assert.notEqual(
      albumFingerprint({ title: 'A', artist: 'C' }),
      albumFingerprint({ title: 'A', artist: 'C', year: 2025 }),
    );
  }

  // ------------------------------------------------------------ 标题清洗
  {
    // A local title carries the packaging; the online sources index the album.
    assert.deepEqual(titleVariants('燕尾蝶<下定爱的决心>'), ['燕尾蝶']);
    assert.deepEqual(titleVariants('爱的大游行Live全记录 (Live)'), ['爱的大游行Live全记录']);
    assert.deepEqual(titleVariants('我好吗? - Single'), ['我好吗?']);
    // A `/` separates two halves; both are offered, and the fan-out is capped.
    assert.deepEqual(titleVariants('A/B/C'), ['A/B/C', 'A']);
    // A plain title stays itself, exactly once.
    assert.deepEqual(titleVariants('范特西'), ['范特西']);
    assert.ok(titleVariants('A/B/C/D').length <= 2, 'a lookup can never fan out');
  }

  // ------------------------------------------------------------ 网易云繁转简
  {
    const twDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-tw-'));
    try {
      // 网易云简介为繁体（含全角空格与换行）；契约是：繁转简、压缩空白、正文只保留简体。
      const fetcher = makeFetcher({
        'music.163.com': neteaseHost({
          detail: {
            name: '测试专辑',
            publishTime: Date.parse('2025-03-14T00:00:00Z'),
            company: '測試唱片',
            size: 10,
            description: '　這是繁體簡介，包含「雙截棍」與「紀念」等詞。\n　　第二行內容。',
          },
        }),
      });
      const resolver = new AlbumOnlineResolver({ dataDir: twDir, fetcher, intervalMs: 0 });
      const outcome = await resolver.netease({ id: 'tw', title: '测试专辑', artist: '测试歌手', year: 2025 });
      assert.equal(outcome.status, 'ok');
      assert.ok(outcome.prose.includes('这是繁体简介'), '繁体简介被转为简体');
      assert.ok(outcome.prose.includes('双截棍') && outcome.prose.includes('纪念'), '繁体词被正确转换');
      assert.ok(!outcome.prose.includes('\n') && !outcome.prose.includes('　'), '全角空格与换行被压缩');
      assert.equal(
        outcome.facts.find((fact) => fact.label === '网易云唱片公司').value,
        '测试唱片',
        '唱片公司与简介一致地繁转简',
      );
    } finally {
      await fs.rm(twDir, { recursive: true, force: true }).catch(() => {});
    }
  }
} finally {
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(downDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(slowDir, { recursive: true, force: true }).catch(() => {});
}

console.log('check-music-online: ok');
