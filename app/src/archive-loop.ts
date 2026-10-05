import { archiveColumns, columnFiles, fileLocation } from "./data.ts";

export type ArchiveCell = { lane: number; row: number };
export type ArchiveNavigation =
  { axis: "row" | "lane"; direction: number } | { cell: ArchiveCell };

export const LOOP_COLUMNS = 9;
export const LOOP_ROWS = 32;
export const MUSIC_LOOP_ROWS = 48;
export const COLUMN_SPACING = 5.2;
export const ROW_SPACING = 0.62;
const POOL_LANES = [0, 1, 2, 3, 4, -2, -1, 5, 6];

export function wrap(value: number, count: number) {
  if (count <= 0) return 0;
  return ((value % count) + count) % count;
}

// Choose an occurrence of an item in an unbounded sequence. Directional moves
// use adjacent cells instead, so the last-to-first transition never reverses.
export function nearestOccurrence(
  value: number,
  center: number,
  period: number,
) {
  if (period <= 0) return value;
  return value + Math.floor((center - value + period / 2) / period) * period;
}

export function fileAtCell({ lane, row }: ArchiveCell) {
  const files = columnFiles(wrap(lane, archiveColumns.length));
  return files[wrap(row - 12, files.length)] ?? -1;
}

export function selectionCell(
  index: number,
  current: ArchiveCell,
  navigation?: ArchiveNavigation,
): ArchiveCell {
  if (navigation && "cell" in navigation) return { ...navigation.cell };
  const next = fileLocation(index);
  const row = nearestOccurrence(
    next.row,
    current.row,
    columnFiles(next.lane).length,
  );
  if (navigation?.axis === "row") {
    return { lane: current.lane, row: current.row + navigation.direction };
  }
  return {
    lane:
      navigation?.axis === "lane"
        ? current.lane + navigation.direction
        : nearestOccurrence(next.lane, current.lane, archiveColumns.length),
    row,
  };
}

// Default to the original 32-row reference. Larger display pools extend both
// ends without changing logical archive rows or the array's 15.5-row center.
export function poolCell(index: number, rows = LOOP_ROWS): ArchiveCell {
  return {
    lane: POOL_LANES[Math.floor(index / rows)],
    row: index % rows - (rows - LOOP_ROWS) / 2,
  };
}

export function visibleCell(index: number, center: ArchiveCell, rows = LOOP_ROWS): ArchiveCell {
  const cell = poolCell(index, rows);
  return {
    lane: nearestOccurrence(
      cell.lane,
      center.lane,
      LOOP_COLUMNS,
    ),
    row: nearestOccurrence(cell.row, center.row, rows),
  };
}

export function cellKey(cell: ArchiveCell) {
  return `${cell.lane}:${cell.row}`;
}

/**
 * Upper bound on the number of distinct albums the display pool can reference.
 *
 * A slot resolves its album through fileAtCell, which indexes one column's file
 * list by row, so a pool lane can only ever show min(rows, files.length)
 * distinct albums; lanes that wrap to the same column share that set. Sizing the
 * cover atlas to this bound instead of to the slot count keeps the atlas surface
 * proportional to the library rather than to the pool: a 79-album library needs
 * 79 tiles, not the 432 slots' worth (108 MB of texture per upload).
 */
export function poolAlbumCapacity(rows = LOOP_ROWS) {
  const columns = new Set<number>();
  for (const lane of POOL_LANES) {
    columns.add(wrap(lane, archiveColumns.length));
  }
  let total = 0;
  for (const column of columns) {
    total += Math.min(rows, columnFiles(column).length);
  }
  return total;
}

export function sameCell(a: ArchiveCell, b: ArchiveCell) {
  return a.lane === b.lane && a.row === b.row;
}
