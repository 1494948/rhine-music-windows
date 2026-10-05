import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MusicLibraryStore } from './music-library.mjs';
import { createMusicServer } from './music-server.mjs';

/**
 * End-to-end check of `GET /api/lyrics/:trackId`.
 *
 * The unit tests cover parsing and sidecar lookup directly; this one covers the
 * wiring between them: a real scan, the real store, the real router. It is the
 * only place where a route typo or a field-name mismatch would be caught before
 * a user opens the pane on a real machine.
 */

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-lyrics-api-'));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-lyrics-data-'));
const folder = path.join(root, '测试歌手', '测试专辑');
const audio = path.join(folder, '01 第一首.mp3');
let server;

try {
  await fs.mkdir(folder, { recursive: true });
  // A minimal ID3 header. Whether music-metadata can read it is beside the
  // point: the scan is expected to fall back to a tagless entry, and the test
  // is about the lyrics route, not about tag coverage.
  await fs.writeFile(audio, Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  await fs.writeFile(
    path.join(folder, '01 第一首.lrc'),
    '[ti:第一首]\n[00:01.00]甲句\n[00:04.00]乙句\n',
    'utf8',
  );

  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [root] }).init();
  await store.scan();
  const snapshot = store.snapshot();
  assert.equal(snapshot.albums.length, 1, 'the synthetic folder scans into one album');
  const trackId = snapshot.albums[0].tracks[0]?.id;
  assert.ok(trackId, 'the synthetic file becomes a track');

  ({ server } = await createMusicServer({ dataDir, defaultRoots: [root], store, autoScan: false }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${origin}/api/lyrics/${trackId}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.equal(payload.source, 'lrc', 'the sidecar is what the route serves');
  assert.ok(payload.text.includes('甲句'));
  // The payload stays a transport format: parsing belongs to the client.
  assert.equal(payload.fingerprint, undefined, 'no internal bookkeeping leaks into the response');
  assert.equal(typeof payload.text, 'string');

  // An unknown id is a plain 404, not a crash.
  const missing = await fetch(`${origin}/api/lyrics/track-000000000000000000000000`);
  assert.equal(missing.status, 404);
  // A malformed id never reaches the store, so it cannot be interpreted as a path.
  const malformed = await fetch(`${origin}/api/lyrics/..%2F..%2Fconfig.json`);
  assert.ok([400, 404].includes(malformed.status), `unexpected status ${malformed.status}`);
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

console.log('check-music-lyrics-api: ok');
