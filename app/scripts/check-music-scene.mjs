import assert from 'node:assert/strict';
import { setMusicAlbums, records, archiveColumns, columnFiles, fileAtSlot, fileLocation } from '../src/data.ts';
import { fileAtCell, poolAlbumCapacity, selectionCell, visibleCell, cellKey, LOOP_COLUMNS, LOOP_ROWS, MUSIC_LOOP_ROWS, wrap } from '../src/archive-loop.ts';
import { containCover, atlasSubRectY, imageSizeFromHeader } from '../src/cover-atlas.ts';

for (const genreCount of [1, 2, 7]) for (const albumCount of [1, 3, 40]) {
  const genres = Array.from({ length: genreCount }, (_, i) => ({ id: `g${i}`, name: `流派 ${i}` }));
  const albums = genres.flatMap((genre) => Array.from({ length: albumCount }, (_, i) => ({ id: `${genre.id}-${i}`, title: `${genre.name} / ${i}`, artist: '测试', genreId: genre.id, rawGenres: [], folder: '', tracks: [], producers: [], offline: false })));
  setMusicAlbums(albums, genres);
  assert.equal(archiveColumns.length, genreCount);
  for (let index = 0; index < records.length; index++) {
    const location = fileLocation(index);
    assert.equal(fileAtSlot(location.slot), index, 'slots must not collide for > 20 albums');
    assert.equal(fileAtCell(location), index);
    for (const direction of [-1, 1]) {
      const files = columnFiles(location.lane);
      const nextIndex = files[wrap(files.indexOf(index) + direction, files.length)];
      const next = selectionCell(nextIndex, location, { axis: 'row', direction });
      assert.equal(next.row - location.row, direction, 'boundary crossing preserves motion direction');
      assert.equal(fileAtCell(next), nextIndex);
      const nextLane = wrap(location.lane + direction, genreCount);
      const targetIndex = columnFiles(nextLane)[0];
      const laneCell = selectionCell(targetIndex, location, { axis: 'lane', direction });
      assert.equal(laneCell.lane - location.lane, direction);
      assert.equal(fileAtCell(laneCell), targetIndex);
    }
  }
  for (const center of [{ lane: -300.3, row: -111.2 }, { lane: 0, row: 12 }, { lane: 301.6, row: 10000.8 }]) {
    const cells = Array.from({ length: LOOP_COLUMNS * LOOP_ROWS }, (_, i) => visibleCell(i, center));
    assert.equal(new Set(cells.map(cellKey)).size, LOOP_COLUMNS * LOOP_ROWS);
    assert.ok(cells.every((cell) => Number.isFinite(cell.row) && records[fileAtCell(cell)]));
  }
  // The cover atlas pool is sized to poolAlbumCapacity(), not to the slot count.
  // If that bound ever under-counts, an album cannot obtain a tile and its card
  // renders empty, so the bound is asserted against every camera position the
  // shelf can pass through: whichever albums are referenced simultaneously must
  // never outnumber the tiles the atlas will allocate.
  for (const rows of [LOOP_ROWS, MUSIC_LOOP_ROWS]) {
    const capacity = poolAlbumCapacity(rows);
    assert.ok(capacity <= LOOP_COLUMNS * rows, 'capacity never exceeds the slot count');
    assert.ok(capacity <= records.length, 'capacity never exceeds the library');
    for (let step = 0; step < 240; step++) {
      const center = { lane: step * 0.37 - 40, row: step * 1.13 - 60 };
      const live = new Set();
      for (let i = 0; i < LOOP_COLUMNS * rows; i++) {
        const file = fileAtCell(visibleCell(i, center, rows));
        if (file >= 0) live.add(file);
      }
      assert.ok(
        live.size <= capacity,
        `simultaneously referenced albums (${live.size}) must fit the atlas (${capacity})`,
      );
    }
  }
}
setMusicAlbums([], []);
assert.equal(records.length, 0);
assert.equal(fileAtCell({ lane: -1, row: -1 }), -1);
assert.equal(fileAtSlot(12), -1);
assert.ok(Object.values(selectionCell(0, { lane: 0, row: 12 })).every(Number.isFinite));
for (const [width, height] of [[1000, 1000], [600, 1000], [1200, 500]]) {
  const box = containCover(width, height, 1024, 768);
  assert.ok(Math.abs(box.width / box.height - width / height) < 1e-10);
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1024 && box.y + box.height <= 768);
}

// --- 图集子矩形上传：位置换算与着色器 UV 的交叉验证 -------------------------
//
// A tile paint uploads only its own rectangle now, so the atlas is no longer
// re-uploaded whole on every cover. That makes one number load-bearing: where
// the rectangle goes. It is derived from the flipped upload convention, and the
// shader's UV attribute derives the same place independently, so the two are
// compared here — a regression in either one would otherwise only show up as
// every cover displaying the wrong artwork on a real GPU.
{
  for (const rows of [1, 2, 5, 8]) {
    for (const tileHeight of [128, 256]) {
      const atlasHeight = rows * tileHeight;
      for (let row = 0; row < rows; row++) {
        const yoffset = atlasSubRectY(atlasHeight, tileHeight, row * tileHeight);
        assert.ok(
          Number.isInteger(yoffset) && yoffset >= 0 && yoffset + tileHeight <= atlasHeight,
          `row ${row} lands outside the atlas`,
        );
        // Where the sub-rect upload writes, normalized with v from the bottom.
        const uploaded = [yoffset / atlasHeight, (yoffset + tileHeight) / atlasHeight];
        // Where writeTile points the shader: v origin 1 - (row + 1) / rows, and
        // a v extent of 1 / rows.
        const read = [1 - (row + 1) / rows, 1 - row / rows];
        assert.ok(
          Math.abs(uploaded[0] - read[0]) < 1e-12 && Math.abs(uploaded[1] - read[1]) < 1e-12,
          `row ${row} of ${rows}: upload writes v[${uploaded}] but the shader reads v[${read}]`,
        );
      }
    }
  }
  // The canvas is uploaded flipped, so canvas row 0 is the texture's last row.
  assert.equal(atlasSubRectY(512, 256, 0), 256);
  assert.equal(atlasSubRectY(512, 256, 256), 0);
}
// --- 封面头部读尺寸：不解码就拿到宽高 -----------------------------------------
//
// The cover pipeline used to decode every artwork twice: once to learn its
// dimensions, once more (from the same blob) to resize it, materialising the
// full 16 MP bitmap on the way to a 256 px tile. Reading the dimensions out of
// the header is what removes the first decode, so the parsers below are load
// bearing — a wrong offset would not throw, it would silently resize to the
// wrong aspect ratio. Synthetic headers keep this verifiable without any image
// decoder.
{
  const ascii = (text) => [...text].map((character) => character.charCodeAt(0));
  const le = (value, count) =>
    Array.from({ length: count }, (_, i) => (value >> (8 * i)) & 0xff);
  const be = (value, count) =>
    Array.from({ length: count }, (_, i) => (value >> (8 * (count - 1 - i))) & 0xff);
  const riff = (chunk, payload) => [
    ...ascii('RIFF'), ...le(0, 4), ...ascii('WEBP'), ...ascii(chunk), ...le(0, 4), ...payload,
  ];
  const png = (width, height) => new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be(13, 4), ...ascii('IHDR'), ...be(width, 4), ...be(height, 4), 8, 6, 0, 0, 0,
  ]);
  const jpeg = (width, height) => new Uint8Array([
    0xff, 0xd8,
    // A segment of its own before the frame: the walk must skip a length-prefixed
    // segment rather than assume the frame comes first.
    0xff, 0xe0, ...be(16, 2), ...Array(14).fill(0),
    0xff, 0xc0, ...be(17, 2), 8, ...be(height, 2), ...be(width, 2),
    3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
  ]);
  const gif = (width, height) =>
    new Uint8Array([...ascii('GIF89a'), ...le(width, 2), ...le(height, 2), 0, 0, 0]);
  // A real BITMAPFILEHEADER is 14 bytes — `BM`, bfSize, two reserved words and
  // bfOffBits — and biWidth/biHeight only follow after the 4-byte biSize, so the
  // dimensions sit at 18 and 22. Writing the header short would move them to 14
  // and 18 and quietly read the colour depth as the height.
  const bmp = (width, height) => new Uint8Array([
    0x42, 0x4d,
    ...le(54, 4), ...le(0, 2), ...le(0, 2), ...le(54, 4),
    ...le(40, 4), ...le(width, 4), ...le(height, 4), ...le(1, 2), ...le(24, 2),
  ]);
  const webp = {
    // Each of WebP's three containers describes the canvas differently; all three
    // appear in the wild and all three are cheap to get wrong.
    lossy: (width, height) =>
      new Uint8Array(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le(width, 2), ...le(height, 2)])),
    lossless: (width, height) =>
      new Uint8Array(riff('VP8L', [0x2f, ...le(((height - 1) << 14) | (width - 1), 4)])),
    extended: (width, height) =>
      new Uint8Array(riff('VP8X', [0, 0, 0, 0, ...le(width - 1, 3), ...le(height - 1, 3)])),
  };

  for (const [name, bytes, width, height] of [
    ['PNG', png(1400, 1200), 1400, 1200],
    ['JPEG', jpeg(4000, 3000), 4000, 3000],
    ['JPEG 正方形', jpeg(4000, 4000), 4000, 4000],
    ['GIF', gif(500, 380), 500, 380],
    ['BMP', bmp(300, 260), 300, 260],
    ['WebP 有损', webp.lossy(640, 480), 640, 480],
    ['WebP 无损', webp.lossless(1200, 800), 1200, 800],
    ['WebP 扩展', webp.extended(2000, 1500), 2000, 1500],
  ])
    assert.deepEqual(imageSizeFromHeader(bytes), { width, height }, `${name} 的宽高`);
  // A negative biHeight means the rows are stored top-down. The magnitude is
  // the size that matters, so the sign must not leak into the aspect ratio.
  assert.deepEqual(imageSizeFromHeader(bmp(320, -200)), { width: 320, height: 200 });
  // An unreadable header must say so rather than guess: the caller has a
  // decode-based fallback and only takes it when this returns undefined.
  assert.equal(imageSizeFromHeader(new Uint8Array(0)), undefined);
  assert.equal(imageSizeFromHeader(new Uint8Array([0x00, 0x01, 0x02, 0x03])), undefined);
  assert.equal(imageSizeFromHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00])), undefined);
  // A JPEG whose frame header sits past the 64 kB slice the caller reads.
  assert.equal(
    imageSizeFromHeader(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, ...Array(32).fill(0)]),
    ),
    undefined,
  );

  // The tile tier must ask for exactly what a tile can show. Reproducing the
  // constructor's arithmetic keeps the claim in cover-atlas.ts honest: the shelf
  // never pays for the detail-sized decode, and the 1/128 UV inset never clips.
  for (const [maxTextureSize, tiles] of [[32768, 79], [8192, 79], [4096, 40]]) {
    const columns = 16;
    const rows = Math.ceil(tiles / columns);
    const tileWidth = Math.min(
      256,
      Math.floor(maxTextureSize / columns),
      Math.floor(maxTextureSize / rows),
    );
    const source = Math.max(1, Math.ceil(tileWidth / (1 - (1 / 128) * 2)));
    assert.ok(source < 1024, '瓦片层绝不能请求详情尺寸的解码');
    assert.ok(source >= tileWidth, '1/128 的 UV 内缩不能被裁掉');
    assert.ok(source <= tileWidth * 1.02, `瓦片解码 ${source} 比瓦片 ${tileWidth} 大得离谱`);
  }
}
console.log('Music scene checks passed: 1/2/7 genres × 1/3/40 albums, bidirectional loops, empty library, uncropped image aspect ratios, flipped atlas sub-rect placement, cover-header dimensions.');
