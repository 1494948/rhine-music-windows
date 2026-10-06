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
  splitUnits,
  unitReveal,
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

// ------------------------------------------------------ 逐字单元与逐字进度

{
  // The unit split is what the pane builds its spans from, and it is the only
  // thing that decides where a line may wrap. The round trip is therefore the
  // load-bearing assertion: if the units do not rejoin into the exact original
  // text, a line would render with a glyph missing or duplicated.
  const cases = [
    '甲乙丙',
    'Hello world',
    '我想将我的寂寞封闭',
    'Hello 世界',
    'a b',
    ' 前导空格',
    '尾部空格 ',
    'Don\'t stop, believing!',
    '甲a乙bb丙',
  ];
  for (const text of cases) {
    const chars = splitChars(text);
    const units = splitUnits(chars);
    assert.equal(units.map((unit) => unit.text).join(''), text, `单元必须拼回原文：${text}`);
    // Ranges have to tile the glyph array exactly, or `unitReveal` would read
    // the wrong onsets.
    let cursor = 0;
    for (const unit of units) {
      assert.equal(unit.start, cursor, `${text} 的单元区间必须连续`);
      assert.ok(unit.end > unit.start, `${text} 出现了空单元`);
      cursor = unit.end;
    }
    assert.equal(cursor, chars.length, `${text} 的单元区间必须覆盖整行`);
  }

  // Chinese is one unit per glyph; Latin is one unit per word, so an English
  // word can never be broken across two `inline-block` boxes.
  assert.deepEqual(
    splitUnits(splitChars('我想')).map((unit) => unit.text),
    ['我', '想'],
  );
  assert.deepEqual(
    splitUnits(splitChars('Hello world')).map((unit) => unit.text),
    ['Hello', ' ', 'world'],
  );
  // Punctuation clings to the word it follows rather than becoming its own box.
  assert.deepEqual(
    splitUnits(splitChars("Don't stop.")).map((unit) => unit.text),
    ["Don't", ' ', 'stop.'],
  );
  // Whitespace is its own unit, which is what keeps a space's advance width
  // from being trimmed at the edge of the preceding box.
  assert.deepEqual(
    splitUnits(splitChars('a  b')).map((unit) => unit.text),
    ['a', '  ', 'b'],
  );
}

{
  // Four glyphs, one second apart: 0s, 1s, 2s, 3s.
  const text = '甲乙丙丁';
  const chars = splitChars(text);
  const timeline = chars.map((char, i) => ({ time: i, char }));
  const units = splitUnits(chars);
  const at = (time) => unitReveal(units, timeline, time);

  // Nothing is lit before the first onset, everything is lit once past the end.
  assert.deepEqual(at(-1), [0, 0, 0, 0]);
  assert.deepEqual(at(0), [0, 0, 0, 0]);
  assert.deepEqual(at(4), [1, 1, 1, 1]);
  assert.deepEqual(at(99), [1, 1, 1, 1]);
  // Halfway through a glyph's own second, that glyph is half filled and the
  // ones after it have not started.
  assert.deepEqual(at(0.5), [0.5, 0, 0, 0]);
  assert.deepEqual(at(2.5), [1, 1, 0.5, 0]);

  // Monotonic per unit: a reveal never runs backwards, which is what lets the
  // pane skip a write whenever the value is unchanged.
  let previous = at(0);
  for (let time = 0; time <= 4; time += 0.05) {
    const current = at(time);
    for (let i = 0; i < current.length; i++)
      assert.ok(current[i] >= previous[i] - 1e-9, '逐字进度不得回退');
    previous = current;
  }

  // A Latin word is one unit spanning four glyphs, so it fills across its own
  // letters instead of snapping when its first letter is reached.
  const wordChars = splitChars('word');
  const wordTimeline = wordChars.map((char, i) => ({ time: i * 0.25, char }));
  const wordUnit = splitUnits(wordChars);
  assert.equal(wordUnit.length, 1);
  const mid = unitReveal(wordUnit, wordTimeline, 0.5)[0];
  assert.ok(mid > 0 && mid < 1, '词组应当在自身区间内连续填充');
  assert.equal(unitReveal(wordUnit, wordTimeline, 0)[0], 0);
  assert.equal(unitReveal(wordUnit, wordTimeline, 1.2)[0], 1);

  // A single-glyph line has no successor to read an end from, so the fallback
  // has to produce a usable interval rather than dividing by zero.
  const single = unitReveal(splitUnits(splitChars('孤')), [{ time: 5, char: '孤' }], 5);
  assert.equal(single.length, 1);
  assert.ok(Number.isFinite(single[0]) && single[0] === 0);

  // Nothing to animate must not throw: the pane calls this before the first
  // clock tick, when the timeline is still empty.
  assert.deepEqual(unitReveal([], [], 3), []);
  assert.deepEqual(unitReveal(splitUnits(splitChars('甲')), [], 3), [1]);
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
    '[data-d="0"]',
    '[data-d="near"]',
    '[data-d="mid"]',
    '[data-d="far"]',
    'lyrics-unsynced',
    'reduce-motion',
    // P2: per-glyph motion, the tier approach and the interlude pulse. Each of
    // these is a property the pane or the settings module writes; if the
    // stylesheet stops reading one, the control silently does nothing.
    'var(--g,',
    '--ly-unit-lift',
    '--ly-unit-pop',
    '--ly-enter',
    '--ly-active-scale',
    '--ly-settle',
    '--ly-dot-period',
    '.lyric-unit',
    'lyric-settle',
    'lyric-float',
    'interlude-breath',
    '.music-lyrics.interlude',
  ];
  for (const token of paneTokens)
    assert.ok(switchCss.includes(token), `music-lyrics-switch.css is missing ${token}`);
  // The thin rule under the singing line was removed on request. Both halves of
  // the mechanism have to stay gone: the pseudo-element itself and the progress
  // property that scaled it.
  assert.ok(
    !switchCss.includes('--line-p'),
    'the removed line-progress sweep must not come back',
  );
  assert.ok(
    !/\.lyric-line[^{]*::after/.test(switchCss),
    'the lyric line must not carry a decorative ::after rule',
  );
  // Every token the settings module writes has to be read by the stylesheet, or
  // the control silently does nothing. This is the failure mode a reviewer
  // cannot see: a typo'd property name is invisible at build time.
  const settingsSource = await read('lyrics-settings.ts');
  const written = [...settingsSource.matchAll(/"(--ly-[a-z-]+)":/g)].map((match) => match[1]);
  assert.ok(written.length >= 10, `expected the token list to be read, found ${written.length}`);
  for (const token of new Set([...written, '--ly-color', '--ly-accent', '--line-h']))
    assert.ok(
      switchCss.includes(`var(${token}`) || switchCss.includes(`${token}:`),
      `lyrics-settings writes ${token} but music-lyrics-switch.css never reads it`,
    );
  // The in-panel preview must render the real thing: same classes, same tiers.
  for (const token of ['lyric-line', 'lyric-main', 'lyric-fill', 'data-d='])
    assert.ok(settingsSource.includes(token), `the preview is missing ${token}`);
  assert.ok(
    appSource.includes('lyricsMarkup(lyricSettings'),
    'the settings panel must be mounted in the app shell',
  );
  assert.ok(
    appSource.includes('applyLyricControl('),
    'the settings controls must be wired to the shared input handler',
  );
  // P3: the panel must also carry the presets, the grouped resets, the JSON
  // transfer and the preview picker — each is an action the shell dispatches.
  for (const token of [
    'lyric-preset',
    'lyric-group-reset',
    'lyric-row-reset',
    'lyric-import',
    'lyric-export',
    'data-lyric-preview="follow"',
  ])
    assert.ok(appSource.includes(token) || settingsSource.includes(token), `missing P3 wiring: ${token}`);
  const switchTokens = [
    '.detail-switch',
    '.detail-switch-halo',
    '.detail-switch-core',
    '.detail-switch-glow',
    'var(--switch-top',
    '.detail-switch.locked',
    '.detail-switch.dragging',
    'switch-float',
    'switch-breathe',
    'switch-glint',
    'animation-play-state: paused',
    ':focus-visible',
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
  // The per-glyph write is the whole of P2's first item: the pane must actually
  // set `--g` on both layers, and it must be the *shared* unit split driving it
  // rather than a second implementation that could drift.
  assert.ok(paneSource.includes('setProperty("--g"'), '歌词面板没有写入逐字进度 --g');
  assert.ok(paneSource.includes('splitUnits'), '歌词面板必须使用共享的单元切分');
  assert.ok(paneSource.includes('unitReveal'), '歌词面板必须使用共享的逐字进度');
  assert.ok(
    paneSource.includes('paintUnits'),
    '歌词面板必须集中在一处写 --g，否则逐帧写入会失控',
  );
  assert.ok(switchSource.includes('translate3d(-50%'));
}

// ------------------------------------------- 线上补录层与面板的接线契约

{
  // The online layer is the only one that can arrive without a source file, so
  // its rules are asserted against the resolver rather than trusted.
  const online = {
    status: 'ok',
    checkedAt: '2026-10-06T00:00:00.000Z',
    blocks: [{ heading: '专辑简介', body: '线上简介正文。', source: { name: '某百科', url: 'https://example.com/c' } }],
    facts: [{ label: '线上首次发行', value: '2025 年 3 月 14 日' }, { label: '', value: '无标签应被丢弃' }],
    sources: [{ name: '某百科', url: 'https://example.com/c', license: 'CC BY-SA 4.0' }, { name: '' }],
    providers: [
      { id: 'musicbrainz', label: 'MusicBrainz', status: 'ok' },
      { id: 'baike', label: '百度百科', status: 'failed', detail: '无法连接' },
    ],
    searchUrl: 'https://www.baidu.com/s?wd=%E6%B5%8B%E8%AF%95%E4%B8%93%E8%BE%91',
  };
  const adopted = resolveAlbumArchive(album(), { ...context, online }, { albums: {} });
  assert.equal(adopted.status, 'online');
  assert.equal(adopted.blocks[0].heading, '专辑简介');
  // Empty entries are dropped rather than rendered as blank rows.
  assert.deepEqual(adopted.facts.filter((fact) => !fact.label), []);
  assert.ok(adopted.facts.some((fact) => fact.label === '线上首次发行'));
  assert.ok(adopted.facts.some((fact) => fact.label === '档案编号'), 'derived facts still follow');
  assert.deepEqual(adopted.sources.map((source) => source.name), ['某百科']);
  // A source that failed is reported separately from the ones that contributed.
  assert.deepEqual(
    adopted.providers.map((provider) => provider.id),
    ['baike'],
    'only the unanswered sources are carried into the panel',
  );
  // Prose was obtained, so the search escape hatch is not offered.
  assert.equal(adopted.searchUrl, undefined);

  // A human override still outranks a live fetch.
  const manual = resolveAlbumArchive(album(), { ...context, online }, {
    albums: { '测试专辑': { significance: '人工意义' } },
  });
  assert.equal(manual.status, 'manual');

  // Nothing adopted: the panel keeps the derived structure and says why.
  const empty = resolveAlbumArchive(
    album(),
    { ...context, online: { status: 'empty', error: '公开来源未找到可靠对应的条目。', searchUrl: 'https://www.baidu.com/s?wd=%E6%B5%8B%E8%AF%95%E4%B8%93%E8%BE%91' } },
    { albums: {} },
  );
  assert.equal(empty.status, 'derived');
  assert.equal(empty.blocks.length, 0, 'a failed lookup never becomes prose');
  // Compared against the pure-derived baseline rather than a hardcoded count:
  // a failed lookup must add nothing, and must remove nothing.
  assert.equal(empty.facts.length, resolveAlbumArchive(album(), context, { albums: {} }).facts.length);
  assert.match(empty.hint, /未采用任何内容/);
  assert.equal(empty.searchUrl, 'https://www.baidu.com/s?wd=%E6%B5%8B%E8%AF%95%E4%B8%93%E8%BE%91');

  // A stored introduction is kept even when the live lookup adopted nothing.
  const withLibrary = resolveAlbumArchive(
    album({ description: '本地已核对简介。', descriptionSource: { name: '某百科', url: 'https://example.com/a' } }),
    { ...context, online: { status: 'error', error: '全部来源不可达' } },
    { albums: {} },
  );
  assert.equal(withLibrary.status, 'library');
  assert.match(withLibrary.hint, /全部来源不可达/);

  // The control row only appears when a caller names an album, which is what
  // keeps a fixture render free of buttons.
  assert.equal(albumArchiveMarkup(adopted, escapeHtml).includes('archive-actions'), false);
  const wired = albumArchiveMarkup(adopted, escapeHtml, {
    albumId: 'album-abc',
    busy: false,
    adopted: true,
    notice: '已读取线上资料。',
  });
  assert.ok(wired.includes('data-status="online"'));
  assert.ok(wired.includes('data-action="online-album"'));
  assert.ok(wired.includes('data-online-feedback="album-abc"'));
  assert.ok(wired.includes('重新读取线上资料'), 'an adopted album offers a refresh');
  assert.ok(wired.includes('未采用的来源'), 'a failed source is listed separately');
  assert.ok(
    albumArchiveMarkup(adopted, escapeHtml, { albumId: 'album-abc', busy: true }).includes('disabled'),
    'a busy control is disabled',
  );
}

{
  // Cross-file contract for the online panel: the actions the controller
  // dispatches, the status the stylesheet styles, and the escape hatch the
  // server hands back all have to be spelled the same way.
  const read = (name) => fs.readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  const [archiveCss, appSource, archiveSource] = await Promise.all([
    read('music-archive.css'),
    read('music-app.ts'),
    read('music-archive.ts'),
  ]);
  assert.ok(archiveCss.includes('[data-status="online"]'));
  assert.ok(archiveCss.includes('.archive-actions'));
  assert.ok(archiveCss.includes('.archive-online-status'));
  for (const action of ['online-album', 'online-library'])
    assert.ok(appSource.includes(`case "${action}"`), `music-app.ts does not dispatch ${action}`);
  assert.ok(appSource.includes('data-action="online-library"'));
  assert.ok(appSource.includes('/api/album-online/'));
  assert.ok(appSource.includes('consent: "1"'), 'a deliberate click is marked as consent');
  // The client must read the same status union the server sends.
  for (const status of ['"manual"', '"online"', '"library"', '"derived"'])
    assert.ok(archiveSource.includes(status), `music-archive.ts has no ${status} status`);
}

console.log('check-music-lyrics: ok');
