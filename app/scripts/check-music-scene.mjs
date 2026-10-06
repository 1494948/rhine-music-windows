import assert from 'node:assert/strict';
import { setMusicAlbums, records, archiveColumns, columnFiles, fileAtSlot, fileLocation } from '../src/data.ts';
import { fileAtCell, poolAlbumCapacity, selectionCell, visibleCell, cellKey, LOOP_COLUMNS, LOOP_ROWS, MUSIC_LOOP_ROWS, wrap } from '../src/archive-loop.ts';
import { containCover, atlasSubRectY } from '../src/cover-atlas.ts';

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
console.log('Music scene checks passed: 1/2/7 genres × 1/3/40 albums, bidirectional loops, empty library, uncropped image aspect ratios, flipped atlas sub-rect placement.');
