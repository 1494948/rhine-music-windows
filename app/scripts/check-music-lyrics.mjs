import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EMPTY_LYRICS,
  charTimeline,
  charWidth,
  findActiveLine,
  karaokeClip,
  lineEndTime,
  parseLrc,
  parseLyricsPayload,
  parsePlainText,
  parseSyncedText,
  splitChars,
} from '../src/music-lyrics.ts';
import { resolveAlbumArchive, albumArchiveMarkup } from '../src/music-archive.ts';
import { escapeHtml } from '../src/html.ts';
import { lyricsCacheSize, readLyrics, resetLyricsCache } from './lyrics.mjs';

/** Float timestamps are compared with a tolerance; LRC decimals are not exact. */
function assertTimes(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) < 1e-9, `time[${index}] ${value} != ${expected[index]}`);
  });
}

// ------------------------------------------------------------------ LRC 解析

{
  const document = parseLrc([
    '[ti:测试专辑]',
    '[ar:测试歌手]',
    '[00:00.00]第一句',
    '[00:12.34]第二句',
    '[00:20.00][00:40.00]重复句',
  ].join('\n'));
  assert.equal(document.synced, true);
  assert.equal(document.source, 'lrc');
  assert.deepEqual(document.lines.map((line) => line.text), ['第一句', '第二句', '重复句', '重复句']);
  assertTimes(document.lines.map((line) => line.time), [0, 12.34, 20, 40]);
}

{
  // Descriptive tags never become lyric lines.
  const document = parseLrc('[ti:歌名]\n[by:某人]\n[00:01.00]词');
  assert.equal(document.lines.length, 1);
  assert.equal(document.lines[0].text, '词');
}

{
  // `[offset:±ms]` shifts every timestamp, so a file written for another rip
  // still lines up.
  const document = parseLrc('[offset:+300]\n[00:10.00]甲\n[00:20.00]乙');
  assert.equal(document.offset, 0.3);
  assert.equal(document.lines[0].time, 10.3);
  assert.equal(document.lines[1].time, 20.3);
}

{
  // Timestamp-only lines mark instrumental gaps; they must not become blanks.
  const document = parseLrc('[00:01.00]甲\n[00:05.00]\n[00:09.00]乙');
  assert.deepEqual(document.lines.map((line) => line.text), ['甲', '乙']);
  assert.equal(document.lines.length, 2);
}

{
  // Colon fractions, one-digit minutes and two-digit hundredths are all seen in
  // the wild. A fraction is right-padded, so `02.5` and `02:50` mean the same.
  const document = parseLrc('[1:02]甲\n[01:02.5]乙\n[01:03:25]丙');
  assert.equal(document.lines.length, 3);
  assertTimes(document.lines.map((line) => line.time), [62, 62.5, 63.25]);
}

{
  // Two tags on the same instant would otherwise draw the line twice.
  const document = parseLrc('[00:05.00]甲\n[00:05.000]乙');
  assert.equal(document.lines.length, 1);
  assert.equal(document.lines[0].text, '乙');
}

{
  // Enhanced LRC carries per-character word timings.
  const document = parseLrc('[00:10.00]<00:10.00>Hello <00:10.60>world');
  const line = document.lines[0];
  assert.equal(line.text, 'Hello world');
  const chars = splitChars(line.text);
  assert.equal(line.chars.length, chars.length);
  const timeline = charTimeline(document, 0, chars);
  assert.deepEqual(timeline.map((entry) => entry.char).join(''), 'Hello world');
  assert.equal(timeline.find((entry) => entry.char === 'w').time, 10.6);
  // Everything before the second tag inherits the first one.
  assert.equal(timeline.find((entry) => entry.char === 'H').time, 10);
  assert.equal(timeline.find((entry) => entry.char === ' ').time, 10);
}

{
  // Untagged lines are spread evenly across the span to the next line, which is
  // what a karaoke sweep needs from a plain LRC file.
  const document = parseLrc('[00:10.00]甲乙丙丁戊\n[00:20.00]己');
  const chars = splitChars(document.lines[0].text);
  const timeline = charTimeline(document, 0, chars);
  assert.equal(timeline.length, 5);
  assertTimes(timeline.map((entry) => entry.time), [10, 12, 14, 16, 18]);
  const spread = timeline[1].time - timeline[0].time;
  assert.ok(spread > 0, 'an evenly distributed fallback advances in time');
  assert.ok(Math.abs(timeline.at(-1).time - timeline[0].time - spread * (chars.length - 1)) < 1e-9);
}

{
  // A line whose word timings do not cover every glyph falls back instead of
  // sweeping out of step.
  const document = parseLrc('[00:10.00]<00:10.00>甲<00:11.00>乙\n[00:20.00]丙');
  const glyphs = splitChars('甲乙');
  const tagged = charTimeline(document, 0, glyphs);
  assertTimes(tagged.map((entry) => entry.time), [10, 11]);
  const mismatched = charTimeline(document, 0, splitChars('甲乙丙丁'));
  assert.equal(mismatched.length, 4, 'a length mismatch cannot produce a partial timeline');
  assertTimes(mismatched.map((entry) => entry.time), [10, 12.5, 15, 17.5]);
}

{
  // CRLF and a truncated payload are both normal.
  const document = parseLrc('[00:01.00]甲\r\n[00:02.00]乙\r\n');
  assert.equal(document.lines.length, 2);
  assert.deepEqual(parseLrc('').lines, []);
  assert.equal(parseLrc('').synced, false);
}

// ----------------------------------------------------- SYLT / USLT / 纯文本

{
  const document = parseSyncedText([
    { text: '甲', timestamp: 1000 },
    { text: '乙', timestamp: 2500 },
    { text: '  ', timestamp: 3000 },
    { text: '丙', timestamp: Number.NaN },
  ]);
  assert.equal(document.source, 'sylt');
  assert.equal(document.synced, true);
  assert.deepEqual(document.lines.map((line) => line.text), ['甲', '乙']);
  assert.deepEqual(document.lines.map((line) => line.time), [1, 2.5]);
}

{
  const document = parsePlainText('第一行\n\n第一行\n第二行');
  assert.equal(document.source, 'plain');
  assert.equal(document.synced, false);
  assert.deepEqual(document.lines.map((line) => line.text), ['第一行', '第二行']);
  assert.ok(document.lines.every((line) => line.time === -1));
}

{
  // Sync wins over text, and LRC text wins over plain text.
  const synced = parseLyricsPayload({ source: 'sylt', sync: [{ text: '甲', timestamp: 2000 }], text: 'ignored' });
  assert.equal(synced.source, 'sylt');
  assert.equal(synced.lines[0].time, 2);
  const lrc = parseLyricsPayload({ source: 'lrc', text: '[00:03.00]甲' });
  assert.equal(lrc.source, 'lrc');
  assert.equal(lrc.lines[0].time, 3);
  const plain = parseLyricsPayload({ source: 'uslt', text: '甲\n乙' });
  assert.equal(plain.source, 'plain');
  assert.equal(plain.lines.length, 2);
  assert.equal(parseLyricsPayload({ source: 'none' }), EMPTY_LYRICS);
  assert.equal(parseLyricsPayload(undefined), EMPTY_LYRICS);
  assert.equal(parseLyricsPayload({ source: 'lrc', text: '   ' }).lines.length, 0);
}

// ------------------------------------------------------------ 时间轴推进

{
  const document = parseLrc('[00:01.00]甲\n[00:05.00]乙\n[00:09.00]丙');
  assert.equal(findActiveLine(document, 0.5), -1);
  assert.equal(findActiveLine(document, 1), 0);
  assert.equal(findActiveLine(document, 4.99), 0);
  assert.equal(findActiveLine(document, 5), 1);
  assert.equal(findActiveLine(document, 1000), 2);
  // An unsynced document has no active line by definition.
  assert.equal(findActiveLine(parsePlainText('甲'), 5), -1);
}

{
  const document = parseLrc('[00:01.00]甲\n[01:40.00]乙');
  // A long instrumental gap must not hold one line on screen for 99 seconds.
  assert.equal(lineEndTime(document, 0), 13);
  assert.equal(lineEndTime(document, 1), 106);
  // The karaoke sweep still finishes inside the line's own span.
  const chars = splitChars('甲乙');
  const timeline = charTimeline(document, 0, chars);
  assert.ok(timeline[1].time <= 13);
}

{
  const document = parseLrc('[00:00.00]abcd');
  const chars = splitChars('abcd');
  const timeline = charTimeline(document, 0, chars);
  assert.equal(karaokeClip(chars, timeline, timeline[0].time - 0.01), 0);
  // A glyph is lit from its own timestamp onward, so at t0 exactly one is lit.
  assert.ok(Math.abs(karaokeClip(chars, timeline, timeline[0].time) - 0.25) < 1e-9);
  assert.equal(karaokeClip(chars, timeline, 999), 1);
  // A CJK glyph weighs double a Latin one, so the sweep matches visually.
  assert.equal(charWidth('甲'), 1);
  assert.equal(charWidth('a'), 0.5);
  const mixed = splitChars('甲a');
  const mixedTimeline = charTimeline(document, 0, mixed);
  // Total width is 1.5, so lighting only the CJK glyph is two thirds.
  assert.ok(Math.abs(karaokeClip(mixed, mixedTimeline, mixedTimeline[0].time) - 2 / 3) < 1e-9);
  assert.equal(karaokeClip(mixed, mixedTimeline, mixedTimeline[1].time), 1);
}

// ------------------------------------------------------------------ 档案面板

function album(overrides = {}) {
  return {
    id: 'album-abc',
    title: '测试专辑',
    artist: '测试歌手',
    year: 2025,
    genreId: 'unclassified',
    rawGenres: [],
    folder: '测试歌手/测试专辑',
    tracks: [
      { id: 'track-1', albumId: 'album-abc', title: '第一首', artist: '测试歌手', duration: 240, format: 'FLAC', sampleRate: 96000, lossless: true, browserPlayable: false, audioUrl: '/api/audio/track-1', relativePath: '01.flac' },
      { id: 'track-2', albumId: 'album-abc', title: '第二首', artist: '测试歌手', duration: 180, format: 'FLAC', sampleRate: 44100, lossless: true, browserPlayable: false, audioUrl: '/api/audio/track-2', relativePath: '02.flac' },
    ],
    producers: [],
    offline: false,
    ...overrides,
  };
}

const context = { ordinal: 75, libraryCount: 79, column: '未分类', columnIndex: 3, columnCount: 9 };

{
  // No override and no fetched introduction: the panel still carries derived
  // structure, and it says where that came from.
  const archive = resolveAlbumArchive(album(), context, { albums: {} });
  assert.equal(archive.status, 'derived');
  assert.equal(archive.blocks.length, 0);
  assert.ok(archive.hint, 'an empty panel explains how to fill it');
  const labels = archive.facts.map((fact) => fact.label);
  assert.ok(labels.includes('档案编号'));
  assert.ok(labels.includes('所在分栏'));
  assert.ok(labels.includes('标签完整度'));
  assert.equal(archive.facts.find((fact) => fact.label === '档案编号').value, 'ALBUM 075 / 079');
  assert.equal(archive.facts.find((fact) => fact.label === '采样率范围').value, '44.1 kHz–96 kHz');
  assert.equal(archive.facts.find((fact) => fact.label === '时长分布').value, '平均 3:30 · 最长 4:00');
  assert.equal(archive.facts.find((fact) => fact.label === '无损占比').value, '全部为无损');
  // No external claim is ever made without a source.
  assert.equal(archive.sources.length, 0);
}

{
  const archive = resolveAlbumArchive(
    album({ description: '这是已核对的简介。', descriptionSource: { name: '某百科', url: 'https://example.com/a', license: 'CC BY-SA 4.0', checkedAt: '2026-10-01' } }),
    context,
    { albums: {} },
  );
  assert.equal(archive.status, 'library');
  assert.equal(archive.blocks[0].heading, '专辑简介');
  assert.equal(archive.blocks[0].source.name, '某百科');
  assert.equal(archive.sources[0].license, 'CC BY-SA 4.0');
}

{
  const file = {
    albums: {
      '测试歌手 - 测试专辑': {
        releaseBackground: '发行背景正文。',
        significance: '专辑意义正文。',
        facts: [{ label: '录音室', value: '某录音室' }, { label: '缺值', value: '  ' }],
        sources: [{ name: '来源甲', url: 'https://example.com/b', checkedAt: '2026-10-02' }, { name: '' }],
      },
    },
  };
  const archive = resolveAlbumArchive(album(), context, file);
  assert.equal(archive.status, 'manual');
  assert.deepEqual(archive.blocks.map((block) => block.heading), ['发行背景', '专辑意义']);
  assert.equal(archive.facts[0].label, '录音室', 'manual facts read first');
  assert.ok(archive.facts.some((fact) => fact.label === '档案编号'), 'derived facts still follow');
  assert.equal(archive.facts.filter((fact) => fact.label === '录音室').length, 1, 'an empty manual fact is dropped');
  assert.deepEqual(archive.sources.map((source) => source.name), ['来源甲']);
  assert.equal(archive.hint, undefined);
}

{
  // Keys match case-insensitively on the artist/title pair, the folder and the
  // title, so an override survives a changed album id.
  const byFolder = resolveAlbumArchive(album(), context, { albums: { '测试歌手/测试专辑': { significance: '按目录命中' } } });
  assert.equal(byFolder.status, 'manual');
  const byTitle = resolveAlbumArchive(album(), context, { albums: { '测试专辑': { significance: '按标题命中' } } });
  assert.equal(byTitle.status, 'manual');
  const byBackslashFolder = resolveAlbumArchive(album(), context, { albums: { '测试歌手\\测试专辑': { significance: '反斜杠等价' } } });
  assert.equal(byBackslashFolder.status, 'manual');
  // An empty record is ignored, so an unfinished entry cannot blank the panel.
  const ignored = resolveAlbumArchive(album(), context, { albums: { '测试专辑': { significance: '   ' } } });
  assert.equal(ignored.status, 'derived');
}

{
  // Whatever a hand-edited JSON contains, it reaches the page as text.
  const archive = resolveAlbumArchive(album({ description: '<img src=x onerror=alert(1)>' }), context, { albums: {} });
  const markup = albumArchiveMarkup(archive, escapeHtml);
  assert.ok(!markup.includes('<img'), 'markup never passes raw text through');
  assert.ok(markup.includes('&lt;img'));
  assert.ok(markup.includes('data-status="library"'));
}

{
  // Importing music-archive.ts pulls in the real content/ JSON. Resolution must
  // be pure: two calls cannot drift, and the shipped file must not be mutated.
  const first = resolveAlbumArchive(album(), context);
  const second = resolveAlbumArchive(album(), context);
  assert.deepEqual(first, second, 'the shipped override file resolves deterministically');
  assert.equal(first.status, 'derived', 'the shipped file starts with no entries');
}

// --------------------------------------------------------- 服务端歌词读取

{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-lyrics-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-outside-'));
  const audio = path.join(root, 'song.mp3');
  const sidecar = path.join(root, 'song.lrc');
  const foreignAudio = path.join(outside, 'other.mp3');
  const noLyrics = path.join(root, 'silent.mp3');
  const brokenAudio = path.join(root, 'broken.mp3');
  const stub = (value) => async () => value;
  try {
    await fs.writeFile(audio, Buffer.from([0x49, 0x44, 0x33, 0x03]));
    await fs.writeFile(foreignAudio, Buffer.from([0x49, 0x44, 0x33, 0x03]));
    await fs.writeFile(noLyrics, Buffer.from([0x49, 0x44, 0x33, 0x03]));
    await fs.writeFile(brokenAudio, Buffer.from([0x49, 0x44, 0x33, 0x04]));
    await fs.writeFile(sidecar, '[00:01.00]第一句\n[00:05.00]第二句\n', 'utf8');

    resetLyricsCache();
    // A same-name .lrc wins outright and skips the tag read entirely.
    const fromSidecar = await readLyrics({ path: audio, allowedRoot: root }, {
      parseFileImpl: stub({ common: { lyrics: [{ text: '标签版本' }] } }),
    });
    assert.equal(fromSidecar.source, 'lrc');
    assert.equal(fromSidecar.text.includes('第二句'), true);
    assert.equal(lyricsCacheSize(), 1);
    assert.equal(parseLrc(fromSidecar.text).lines.length, 2);

    // The cache is keyed by fingerprint, so an edited sidecar is re-read.
    await fs.writeFile(sidecar, '[00:02.00]改过的\n', 'utf8');
    await fs.utimes(sidecar, new Date(), new Date(Date.now() + 2000));
    const edited = await readLyrics({ path: audio, allowedRoot: root }, { parseFileImpl: stub({}) });
    assert.equal(edited.text.includes('改过的'), true);
    assert.equal(lyricsCacheSize(), 1);

    // GB18030 sidecars are common in Chinese libraries; a mis-decode is retried.
    await fs.writeFile(sidecar, Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xbe, 0xe4]));
    await fs.utimes(sidecar, new Date(), new Date(Date.now() + 4000));
    const decoded = await readLyrics({ path: audio, allowedRoot: root }, { parseFileImpl: stub({}) });
    assert.equal(decoded.source, 'lrc');
    assert.equal(decoded.text.includes('\uFFFD'), false, 'a GB18030 sidecar must not surface replacement characters');

    // A sidecar outside the configured music root is ignored, and SYLT tags take
    // over: sync timings are preferred over unsynchronised text.
    const fromTag = await readLyrics({ path: foreignAudio, allowedRoot: outside }, {
      parseFileImpl: stub({ common: { lyrics: [{ text: '纯文本', syncText: [{ text: '甲', timestamp: 1000 }, { text: '乙', timestamp: 2500 }] }] } }),
    });
    assert.equal(fromTag.source, 'sylt');
    assert.deepEqual(fromTag.sync.map((entry) => entry.timestamp), [1000, 2500]);

    const fromUslt = await readLyrics({ path: noLyrics, allowedRoot: root }, {
      parseFileImpl: stub({ common: { lyrics: [{ text: '只有 USLT' }] } }),
    });
    assert.equal(fromUslt.source, 'uslt');
    assert.equal(fromUslt.text, '只有 USLT');

    // The second read is served from the fingerprint cache, so it does not pay
    // for another tag parse — this is what makes reopening the pane free.
    const cached = await readLyrics({ path: noLyrics, allowedRoot: root }, {
      parseFileImpl: stub({ common: { lyrics: [{ text: '不应被读到' }] } }),
    });
    assert.equal(cached.text, '只有 USLT');

    // A parser that throws is reported as "no lyrics" rather than escaping.
    const none = await readLyrics({ path: brokenAudio, allowedRoot: root }, {
      parseFileImpl: async () => { throw new Error('unreadable tag block'); },
    });
    assert.deepEqual(none, { source: 'none' });

    // A path escape must not be served even if the store ever passed one on.
    await fs.writeFile(path.join(root, 'escaped.lrc'), '[00:01.00]不应被读取\n', 'utf8');
    const escaped = await readLyrics({ path: audio, allowedRoot: outside }, {
      parseFileImpl: stub({}),
    });
    assert.equal(escaped.source, 'none', 'a sidecar outside the root is never read');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
}

// ------------------------------------------- 控制器与样式表之间的契约检查

{
  // Every class, attribute and custom property the controllers write has to be
  // spelled the same way in the stylesheets. A mismatch is invisible at build
  // time and only shows up as a missing animation, so it is asserted here.
  const read = (name) => fs.readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  const [switchCss, archiveCss, paneSource, switchSource, appSource] = await Promise.all([
    read('music-lyrics-switch.css'),
    read('music-archive.css'),
    read('music-lyrics-pane.ts'),
    read('music-detail-switch.ts'),
    read('music-app.ts'),
  ]);
  const paneTokens = [
    'var(--reveal',
    'var(--shift',
    'var(--line-h',
    'var(--i,',
    'var(--blur',
    'var(--p,',
    'var(--line-p',
    '[data-d="0"]',
    '[data-d="near"]',
    '[data-d="mid"]',
    '[data-d="far"]',
    'lyrics-unsynced',
    'reduce-motion',
  ];
  for (const token of paneTokens)
    assert.ok(switchCss.includes(token), `music-lyrics-switch.css is missing ${token}`);
  const switchTokens = [
    '.detail-switch',
    '.detail-switch-core',
    '.detail-switch-glow',
    'var(--switch-top',
    '.detail-switch.locked',
    '.detail-switch.dragging',
    'switch-float',
    'touch-action: none',
  ];
  for (const token of switchTokens)
    assert.ok(switchCss.includes(token), `music-lyrics-switch.css is missing ${token}`);
  for (const token of ['data-status="derived"', '.archive-lead', '.archive-facts', '.archive-hint', '.detail-surface'])
    assert.ok(archiveCss.includes(token), `music-archive.css is missing ${token}`);
  // The ids the controllers look up have to exist in the shell the app writes.
  for (const id of ['detail-surface', 'album-detail-content'])
    assert.ok(appSource.includes(`id="${id}"`), `music-app.ts no longer creates #${id}`);
  // The custom properties the switch reads are declared on the detail page.
  assert.ok(switchCss.includes('--switch-top: ') && switchCss.includes('--switch-bottom: '));
  // And the ones the pane sets are consumed by the stylesheet it ships with.
  assert.ok(paneSource.includes('setProperty("--reveal"'));
  assert.ok(paneSource.includes('setProperty("--shift"'));
  assert.ok(paneSource.includes('dataset.d ='));
  assert.ok(switchSource.includes('translate3d(-50%'));
}

console.log('check-music-lyrics: ok');
