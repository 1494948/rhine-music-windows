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
} from './album-online.mjs';

/**
 * Contract check for the online album supplement.
 *
 * The fetcher is injected, so every branch is reachable without a network:
 * agreement, near miss, unreachable host, overall deadline, cache hit and TTL
 * expiry. Two promises are asserted hardest, because they are the ones a
 * reviewer cannot otherwise see:
 *
 *   1. Nothing is invented. A fact may only carry a label this module produces
 *      itself, prose only ever comes from a quoted source, and every adopted
 *      source carries a licence and a URL.
 *   2. A dead host is not re-asked. One connect failure must take that provider
 *      out of rotation and persist the decision, or a black-holed DNS entry
 *      costs every album in the library a full timeout.
 */

/** Every fact label the module is allowed to emit. */
const FACT_LABELS = new Set([
  '线上专辑类型',
  '线上首次发行',
  '年份差异',
  '线上匹配度',
  '商店发行日期',
  '商店流派',
  '商店收录曲目',
  '版权声明',
]);

const HIT = { id: 'album-aaaa1111', title: '测试专辑', artist: '测试歌手', year: 2025 };
const OFF_YEAR = { id: 'album-cccc3333', title: '测试专辑', artist: '测试歌手', year: 2001 };
const NEAR_MISS = { id: 'album-bbbb2222', title: '另一个专辑', artist: '别的歌手', year: 1997 };

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

/** Wikipedia is the network this build cannot reach; it must stay best-effort. */
const WIKI_DOWN = () => new Error('connect ECONNREFUSED 127.0.0.1:443');

/** Every host the module is allowed to talk to, by suffix rule. */
const HOST_ALLOWED = (host) =>
  host === PROVIDER_HOSTS.musicbrainz ||
  host === PROVIDER_HOSTS.itunes ||
  host === 'www.wikidata.org' ||
  host.endsWith(`.${PROVIDER_HOSTS.wikipedia}`);

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
      'musicbrainz.org': MUSICBRAINZ_HIT,
      'itunes.apple.com': ITUNES_HIT,
      'zh.wikipedia.org': WIKI_DOWN,
      'en.wikipedia.org': WIKI_DOWN,
    });
    const resolver = new AlbumOnlineResolver({ dataDir, fetcher, intervalMs: 0 });

    const payload = await resolver.resolve(HIT);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.fingerprint, albumFingerprint(HIT));
    assert.ok(payload.checkedAt, 'a payload always records when it was checked');

    // Only the safe hosts were contacted, and only through their own APIs.
    assert.ok(fetcher.calls.length >= 2, 'the working providers were actually asked');
    const stray = [...new Set(fetcher.calls)].filter((host) => !HOST_ALLOWED(host));
    assert.deepEqual(stray, [], `unexpected host contacted: ${stray}`);

    // Nothing invented: every label is one this module owns.
    assert.ok(payload.facts.length > 0);
    for (const fact of payload.facts) {
      assert.ok(FACT_LABELS.has(fact.label), `unowned fact label: ${fact.label}`);
      assert.ok(fact.value, `fact ${fact.label} carries no value`);
    }
    const labels = new Set(payload.facts.map((fact) => fact.label));
    for (const expected of ['线上专辑类型', '线上首次发行', '线上匹配度', '商店发行日期', '商店流派', '商店收录曲目', '版权声明'])
      assert.ok(labels.has(expected), `missing fact ${expected}`);
    assert.equal(payload.facts.find((fact) => fact.label === '线上专辑类型').value, 'Album');

    // Both working sources are attributed, with a licence and a link.
    const names = payload.sources.map((source) => source.name).sort();
    assert.deepEqual(names, ['Apple Music 商店（CN）', 'MusicBrainz']);
    for (const source of payload.sources) {
      assert.ok(source.url?.startsWith('https://'), `source ${source.name} has no https link`);
      assert.ok(source.license, `source ${source.name} has no licence`);
      assert.ok(source.checkedAt, `source ${source.name} has no checkedAt`);
    }

    // Each provider reports its own outcome, so the panel can be honest.
    assert.deepEqual(
      payload.providers.map((provider) => [provider.id, provider.status]),
      [
        ['musicbrainz', 'ok'],
        ['itunes', 'ok'],
        ['wikipedia', 'failed'],
      ],
    );
    const wiki = payload.providers.find((provider) => provider.id === 'wikipedia');
    assert.match(wiki.detail, /连接失败|无法连接|connect/i, 'the failure reason must be readable');
    assert.ok(payload.searchUrl?.startsWith('https://'), 'a search link is offered as a way out');

    // The assembled sentence follows the provider order, not the completion
    // order, so the same album never reads back differently.
    const background = payload.blocks.find((block) => block.heading === '发行背景');
    assert.ok(background, 'a 发行背景 block is assembled from the returned fields');
    const first = background.body.indexOf('公开条目记录其首次发行');
    const second = background.body.indexOf('商店记录的上架日期');
    assert.ok(first >= 0 && second > first, 'provider order decides the sentence order');
    assert.ok(background.body.includes('商店归类为 流行'));
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
    assert.equal(
      forced.providers.find((provider) => provider.id === 'wikipedia').status,
      'skipped',
      'the failed host stays out of rotation',
    );
    assert.match(
      forced.providers.find((provider) => provider.id === 'wikipedia').detail,
      /暂停/,
    );

    // -------------------------------------------------------- 近失不采用
    const miss = await resolver.resolve(NEAR_MISS);
    assert.equal(miss.status, 'empty', 'a near miss is reported as empty, not as a hit');
    assert.equal(miss.blocks.length, 0);
    assert.equal(miss.facts.length, 0);
    assert.equal(miss.sources.length, 0, 'nothing adopted means nothing to attribute');
    assert.equal(typeof miss.error, 'string', 'an empty result explains itself');

    // A cache file is written beside the library data, keyed by album identity.
    const cacheFile = path.join(dataDir, 'album-online', `${HIT.id}.json`);
    const raw = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    assert.equal(raw.fingerprint, albumFingerprint(HIT));
    assert.equal(raw.providers.length, 3);

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
    assert.deepEqual(Object.keys(breakers).sort(), ['itunes', 'musicbrainz', 'wikipedia']);

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
    assert.equal(payload.providers.length, 3);
    for (const provider of payload.providers) {
      assert.equal(provider.status, 'failed');
      assert.match(provider.detail, /预算/, 'a missed budget says so');
    }
    // A deadline is not a connect failure, so it must not trip the breaker.
    const breakerFile = path.join(slowDir, 'album-online', '_breakers.json');
    const exists = await fs.readFile(breakerFile, 'utf8').then(() => true, () => false);
    assert.equal(exists, false, 'a slow host is not marked down');
  }

  // -------------------------------------------------- 限流重试与来源记账
  {
    const retryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-retry-'));
    try {
      // MusicBrainz documents 503 as "back off and retry", and a library-wide
      // pass is exactly the workload that trips it. One retry must happen, and
      // only one: an unbounded retry would turn a rate limit into a hammer.
      let attempts = 0;
      const flaky = makeFetcher({
        'musicbrainz.org': () => {
          attempts++;
          return attempts === 1 ? { __http: 503 } : MUSICBRAINZ_HIT();
        },
        'itunes.apple.com': () => ({ __http: 500 }),
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

      // A 500 is a real error, not a rate limit, so it is not retried and the
      // store is reported as unreachable rather than as empty.
      const store = payload.providers.find((provider) => provider.id === 'itunes');
      assert.equal(store.status, 'failed', 'a store that only ever errored is not "empty"');
      assert.match(store.detail, /HTTP 500/);
      assert.equal(flaky.calls.filter((host) => host === 'itunes.apple.com').length, 2,
        'both storefronts were tried, and neither was retried');
    } finally {
      await fs.rm(retryDir, { recursive: true, force: true }).catch(() => {});
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
} finally {
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(downDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(slowDir, { recursive: true, force: true }).catch(() => {});
}

console.log('check-music-online: ok');
