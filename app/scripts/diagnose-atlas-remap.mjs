// 诊断：量化"跨列切换"与"同列切换"在封面图集上的重绘规模。
//
// 背景：scene.ts 每帧对全部 432 个槽位调用 covers.setSlot(i, records[fileAtCell(cells[i]))。
// CoverAtlas.paintTile 每次重绘都会置 atlas.needsUpdate，逼出一整张 4096x6912 RGBA
// 贴图的上传（约 113 MB）。因此"一次导航触发多少次槽位重映射"直接等于该次导航的
// 卡顿量级。
//
// 本脚本不依赖浏览器：直接调用真实的 visibleCell / fileAtCell / columnFiles，
// 模拟相机中心扫过一列 / 一行，统计每一步的槽位重映射数与新进图集的相册数。
//
// 用法：node scripts/diagnose-atlas-remap.mjs

import { setMusicAlbums, archiveColumns, columnFiles } from '../src/data.ts';
import { fileAtCell, poolAlbumCapacity, visibleCell, MUSIC_LOOP_ROWS, LOOP_COLUMNS } from '../src/archive-loop.ts';

const SLOTS = LOOP_COLUMNS * MUSIC_LOOP_ROWS; // 432
const ATLAS_COLUMNS = 16;
const TILE = 256;
const ATLAS_ROWS = Math.ceil(SLOTS / ATLAS_COLUMNS);
const ATLAS_BYTES = ATLAS_COLUMNS * ATLAS_ROWS * TILE * TILE * 4;

const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 以 band 限定"会真正被绘制"的槽位；band=Infinity 表示当前的全量绘制行为。 */
function fingerprint(center, band) {
  const out = new Map();
  for (let i = 0; i < SLOTS; i++) {
    const cell = visibleCell(i, center, MUSIC_LOOP_ROWS);
    if (Math.abs(cell.lane - center.lane) > band) continue;
    out.set(i, fileAtCell(cell));
  }
  return out;
}

/** 相机中心从 from 平滑移到 to，统计累计重映射槽位与新进图集的相册数。 */
function sweep(from, to, key, band, steps = 120) {
  let previous = fingerprint(from, band);
  let remaps = 0;
  const entering = new Set();
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const center = { ...from, [key]: from[key] + (to[key] - from[key]) * t };
    const next = fingerprint(center, band);
    for (const [slot, file] of next) {
      const before = previous.get(slot);
      if (before !== undefined && before !== file) {
        remaps++;
        if (file >= 0) entering.add(file);
      }
    }
    previous = next;
  }
  return { remaps, entering: entering.size };
}

function buildLibrary(genreCount, albumsPerGenre) {
  const genres = Array.from({ length: genreCount }, (_, i) => ({ id: `g${i}`, name: `流派${i}` }));
  const albums = genres.flatMap((genre) =>
    Array.from({ length: albumsPerGenre }, (_, i) => ({
      id: `${genre.id}-${i}`,
      title: `${genre.name} / ${i}`,
      artist: '测试歌手',
      genreId: genre.id,
      rawGenres: [],
      folder: '',
      tracks: [],
      producers: [],
      offline: false,
    })),
  );
  setMusicAlbums(albums, genres);
  return albums.length;
}

console.log('封面图集重映射诊断');
console.log(`槽位=${SLOTS}（${LOOP_COLUMNS} 列 x ${MUSIC_LOOP_ROWS} 行）  图集=${ATLAS_COLUMNS * TILE}x${ATLAS_ROWS * TILE}  单次整表上传≈${fmtMB(ATLAS_BYTES)}`);
console.log('');

const rows = [];
for (const [genreCount, albumsPerGenre] of [[4, 12], [7, 40], [12, 60]]) {
  const total = buildLibrary(genreCount, albumsPerGenre);
  const center = { lane: 2, row: 12 };
  for (const band of [Infinity, 2, 1]) {
    const lane = sweep(center, { ...center, lane: center.lane + 1 }, 'lane', band);
    const row = sweep(center, { ...center, row: center.row + 1 }, 'row', band);
    rows.push({
      曲库: `${genreCount} 流派 x ${albumsPerGenre} 张 = ${total}`,
      绘制范围: band === Infinity ? '全部(现状)' : `±${band} 列`,
      跨列一步: `${lane.remaps} 槽位 / ${lane.entering} 张新封面`,
      同列一步: `${row.remaps} 槽位 / ${row.entering} 张新封面`,
    });
  }
  console.log(`— 每列专辑数 ${albumsPerGenre}（列内 ${columnFiles(0).length} 张，共 ${archiveColumns.length} 列）`);
}

console.table(rows);

console.log('');
console.log('结论：跨列一步会重映射整整一组（最多一整列 48 个）槽位并引入成批新封面；');
console.log('同列一步因为行轴周期为 48，常规步进几乎不重映射 —— 这正是"同行流畅、跨列卡顿"的机制。');
console.log('注意：重映射的是槽位，真正触发 paintTile 的是其中"不同的专辑"（tileOf 按专辑去重）；');
console.log('但图集表面按槽位数固定分配，于是一张封面也要上传整张图集。');

// —— 图集表面：按槽位数固定分配 vs 按可达专辑数分配 ——
const atlasBytes = (tiles) => Math.ceil(tiles / ATLAS_COLUMNS) * ATLAS_COLUMNS * TILE * TILE * 4;
const atlasSize = (tiles) =>
  `${ATLAS_COLUMNS * TILE}x${Math.ceil(tiles / ATLAS_COLUMNS) * TILE}`;

console.log('');
console.log('图集表面（单次重绘上传量）：');
console.log(`  现状（按 ${SLOTS} 槽位固定分配）: ${atlasSize(SLOTS)} = ${fmtMB(atlasBytes(SLOTS))}`);
for (const [genreCount, albumsPerGenre] of [[4, 20], [8, 10], [12, 7], [7, 40]]) {
  const total = buildLibrary(genreCount, albumsPerGenre);
  const capacity = poolAlbumCapacity(MUSIC_LOOP_ROWS);
  const unique = new Set();
  for (let i = 0; i < SLOTS; i++) {
    const file = fileAtCell(visibleCell(i, { lane: 2, row: 12 }, MUSIC_LOOP_ROWS));
    if (file >= 0) unique.add(file);
  }
  console.log(
    `  ${String(genreCount).padStart(2)} 列 x ${String(albumsPerGenre).padStart(2)} 张（共 ${String(total).padStart(3)} 张）:` +
      ` 容量 ${String(capacity).padStart(3)} 片 = ${atlasSize(capacity).padEnd(10)} = ${fmtMB(atlasBytes(capacity)).padStart(7)}` +
      `  （单帧实引用 ${unique.size} 张，约为现状的 ${(atlasBytes(SLOTS) / atlasBytes(capacity)).toFixed(1)} 分之一）`,
  );
}
