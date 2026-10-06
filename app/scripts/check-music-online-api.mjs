import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MusicLibraryStore } from './music-library.mjs';
import { createMusicServer } from './music-server.mjs';

/**
 * End-to-end check of `GET /api/album-online/:id`.
 *
 * The resolver's own branches are covered by `check-music-online.mjs`; what is
 * checked here is only the wiring a unit test cannot see: the consent gate, the
 * unknown-album 404, and the id pattern that keeps a malformed id from ever
 * reaching the resolver. None of these three may touch the network, so this
 * script stays offline and instant — the happy path is exercised against the
 * real library by hand, from the detail page.
 */

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-api-'));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-api-data-'));
let server;

try {
  const folder = path.join(root, '测试歌手', '测试专辑');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(
    path.join(folder, '01 第一首.mp3'),
    Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  );

  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [root] }).init();
  await store.scan();
  const albumId = store.snapshot().albums[0]?.id;
  assert.ok(albumId, 'the synthetic folder scans into an album');

  ({ server } = await createMusicServer({ dataDir, defaultRoots: [root], store, autoScan: false }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // Without a deliberate click, and with automatic enrichment off, the route
  // answers with a reason rather than silently doing nothing. This is the state
  // a default install is in, so it is the one that must not look like a failure.
  assert.equal(store.config.onlineEnabled, false, 'automatic enrichment is off by default');
  const gated = await fetch(`${origin}/api/album-online/${albumId}`);
  assert.equal(gated.status, 200);
  const gatedBody = await gated.json();
  assert.equal(gatedBody.status, 'disabled');
  assert.equal(typeof gatedBody.reason, 'string');
  assert.match(gatedBody.reason, /线上/);

  // An unknown album is a plain 404, not a resolver call.
  const missing = await fetch(`${origin}/api/album-online/album-000000000000000000000000?consent=1`);
  assert.equal(missing.status, 404);

  // A malformed id must not reach the resolver at all: the route pattern only
  // accepts the slug alphabet the scanner produces. Anything else has to fall
  // through to the static handler rather than be interpreted as a path.
  for (const bad of ['..%2F..%2Fconfig.json', 'album%20with%20space', 'album%2Fsub', 'album.x']) {
    const response = await fetch(`${origin}/api/album-online/${bad}?consent=1`);
    assert.ok(
      [400, 404].includes(response.status),
      `malformed id ${bad} returned ${response.status}`,
    );
  }
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

console.log('check-music-online-api: ok');
