import * as THREE from "three";
import type { MusicSelectionLighting } from "./music-lighting";
import type { ArchiveRecord } from "./data";
import { MUSIC_COVER, createAlbumPrintMaterial } from "./music-model.ts";
import { poolAlbumCapacity, LOOP_ROWS } from "./archive-loop.ts";

// Print on the glass surface. No transmitting/frosted layer sits over the image.
export const COVER_SIZE = MUSIC_COVER;
type CoverImage = { source: HTMLCanvasElement | ImageBitmap; width: number; height: number };
const COVER_PAINT_SIZE = 1024;
// Thumbnails are retained, never the decoded multi-megapixel source art.
const MAX_THUMBNAIL = 1024;
// Hold the pool's albums so navigating back and forth never re-decodes a cover a
// lane switch has already paid for; bounded so thumbnail memory stays finite.
const IMAGE_CACHE_LIMIT = 96;
// Use the same UV margin at every texture resolution. A fixed two-pixel inset
// made the 256px atlas artwork smaller than its 1024px lifted/returning copy.
export const COVER_INSET = 1 / 128;
const COVER_PAINT_MARGIN = COVER_PAINT_SIZE * COVER_INSET;

export function containCover(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
) {
  const scale = Math.min(
    boxWidth / Math.max(1, width),
    boxHeight / Math.max(1, height),
  );
  const drawnWidth = width * scale,
    drawnHeight = height * scale;
  return {
    x: (boxWidth - drawnWidth) / 2,
    y: (boxHeight - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight,
  };
}

function paintCover(
  canvas: HTMLCanvasElement,
  record: ArchiveRecord | undefined,
  image?: CoverImage,
) {
  const context = canvas.getContext("2d")!;
  // Paint in one logical coordinate space, including fallback art and labels.
  // Ownership can move between atlas/selection/snapshot without rescaling art.
  const width = COVER_PAINT_SIZE,
    height = COVER_PAINT_SIZE,
    margin = COVER_PAINT_MARGIN;
  context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  context.clearRect(0, 0, width, height);
  if (image) {
    const box = containCover(image.width, image.height, width - margin * 2, height - margin * 2);
    context.drawImage(
      image.source,
      box.x + margin,
      box.y + margin,
      box.width,
      box.height,
    );
    return;
  }
  // A missing cover is explicit and never substituted with another album's art.
  const size = height - margin * 2,
    left = (width - size) / 2;
  context.fillStyle = "#c9c9c4";
  context.fillRect(left, margin, size, size);
  context.strokeStyle = "#f8f7f1";
  context.lineWidth = Math.max(1, height / 180);
  context.beginPath();
  context.arc(width / 2, height * 0.43, height * 0.2, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.arc(width / 2, height * 0.43, height * 0.04, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = "#3f4849";
  context.textAlign = "center";
  context.font = `500 ${Math.max(12, height * 0.045)}px sans-serif`;
  context.fillText(
    record?.title ?? "暂无专辑封面",
    width / 2,
    height * 0.8,
    height * 0.83,
  );
  context.font = `${Math.max(9, height * 0.025)}px sans-serif`;
  context.fillText(
    "LOCAL COLLECTION / NO COVER",
    width / 2,
    height * 0.87,
    height * 0.83,
  );
}

/** One fixed-size atlas for the visible pool, regardless of total library size. */
export class CoverAtlas {
  readonly array: THREE.InstancedMesh;
  readonly selected: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  private readonly atlasCanvas = document.createElement("canvas");
  private readonly selectedCanvas = document.createElement("canvas");
  private readonly tileCanvas = document.createElement("canvas");
  private atlas: THREE.CanvasTexture;
  private readonly selectedTexture: THREE.CanvasTexture;
  private readonly images = new Map<string, Promise<CoverImage | undefined>>();
  // Mirror of images' resolved values: a tile that already owns its artwork can
  // paint once instead of flashing the placeholder and repainting on arrival.
  private readonly resolved = new Map<string, CoverImage>();
  private readonly slotKeys: (string | undefined)[];
  // Tiles are keyed by album, not by pool slot. The pool shows one album in many
  // positions, and a slot-keyed atlas had to repaint and re-upload most of its
  // 4096x6912 surface whenever the shelf scrolled or changed genre: measured 48
  // tile repaints and five ~108 MB uploads inside a single switch. One tile per
  // distinct album means scrolling changes only which tile an instance points at,
  // so the upload stops happening during navigation entirely.
  private readonly tileOf = new Map<string, number>();
  private tileKeys: (string | undefined)[];
  private tileRefs: Int32Array;
  private readonly slotTile: Int32Array;
  private readonly freeTiles: number[] = [];
  private readonly tileAttribute: THREE.InstancedBufferAttribute;
  private tileCount: number;
  private readonly recordKeys = new WeakMap<ArchiveRecord, string>();
  private selectedRecord?: ArchiveRecord;
  private generation = 0;
  private disposed = false;
  private readonly columns = 16;
  private rows: number;
  private readonly tileWidth: number;
  private readonly tileHeight: number;
  // Slot count (the display pool) and the rows each lane spans, kept apart from
  // the tile count so the atlas can be sized to the albums actually reachable.
  private readonly slotCount: number;
  private readonly poolRows: number;
  private readonly atlasAnisotropy: number;

  constructor(
    count: number,
    maxTextureSize: number,
    anisotropy: number,
    lighting?: MusicSelectionLighting,
    poolRows: number = LOOP_ROWS,
  ) {
    this.slotCount = count;
    this.poolRows = poolRows;
    // Capacity, not slot count: a library of 79 albums needs 79 tiles however
    // many slots the pool has, and every spare tile is atlas surface re-uploaded
    // on each repaint.
    this.tileCount = Math.max(1, Math.min(count, poolAlbumCapacity(poolRows)));
    this.rows = Math.ceil(this.tileCount / this.columns);
    this.tileWidth = Math.min(
      256,
      Math.floor(maxTextureSize / this.columns),
      Math.floor(maxTextureSize / this.rows),
    );
    this.tileHeight = this.tileWidth;
    this.atlasCanvas.width = this.columns * this.tileWidth;
    this.atlasCanvas.height = this.rows * this.tileHeight;
    this.tileCanvas.width = this.tileWidth;
    this.tileCanvas.height = this.tileHeight;
    this.selectedCanvas.width = COVER_PAINT_SIZE;
    this.selectedCanvas.height = COVER_PAINT_SIZE;
    this.slotKeys = Array(count);
    this.tileKeys = Array(this.tileCount);
    this.tileRefs = new Int32Array(this.tileCount);
    this.slotTile = new Int32Array(count).fill(-1);
    for (let i = this.tileCount - 1; i >= 0; i--) this.freeTiles.push(i);
    this.atlasAnisotropy = Math.min(4, anisotropy);
    this.atlas = this.createAtlasTexture();
    this.selectedTexture = new THREE.CanvasTexture(this.selectedCanvas);
    this.selectedTexture.colorSpace = THREE.SRGBColorSpace;
    this.selectedTexture.anisotropy = Math.min(8, anisotropy);
    const geometry = new THREE.PlaneGeometry(
      COVER_SIZE.width,
      COVER_SIZE.height,
    ).translate(COVER_SIZE.x, COVER_SIZE.y, COVER_SIZE.z);
    // The per-instance tile rectangle is assigned by setSlot, once it knows which
    // album sits in that position; until then it stays degenerate and invisible.
    const tileAttribute = new THREE.InstancedBufferAttribute(
      new Float32Array(count * 4),
      4,
    );
    tileAttribute.setUsage(THREE.DynamicDrawUsage);
    this.tileAttribute = tileAttribute;
    geometry.setAttribute("coverTile", tileAttribute);
    // Instances, selected art and snapshots use one matte diffuse material and
    // one moving light field; no ownership-specific brightness/scale switches.
    const makePrint = (texture: THREE.Texture) => {
      const print = createAlbumPrintMaterial(texture);
      const compile = print.onBeforeCompile;
      print.onBeforeCompile = (shader, renderer) => {
        compile.call(print, shader, renderer);
        lighting?.shadePrint(shader);
      };
      print.customProgramCacheKey = () => `album-diffuse-print-${Boolean(lighting)}-v1`;
      return print;
    };
    const material = makePrint(this.atlas);
    const compileAtlas = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      compileAtlas.call(material, shader, renderer);
      shader.vertexShader = "attribute vec4 coverTile;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\nvMapUv = coverTile.xy + uv * coverTile.zw;",
      );
    };
    material.customProgramCacheKey = () => `album-diffuse-atlas-${Boolean(lighting)}-v1`;
    this.array = new THREE.InstancedMesh(geometry, material, count);
    this.array.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.array.frustumCulled = false;
    this.array.visible = false;
    this.array.name = "Album cover atlas";
    this.array.receiveShadow = true;
    this.selected = new THREE.Mesh(
      new THREE.PlaneGeometry(COVER_SIZE.width, COVER_SIZE.height).translate(
        COVER_SIZE.x,
        COVER_SIZE.y,
        COVER_SIZE.z,
      ),
      makePrint(this.selectedTexture),
    );
    this.selected.userData.albumCover = true;
    this.selected.visible = false;
    this.selected.name = "Selected album cover";
    this.selected.receiveShadow = true;
  }

  private createAtlasTexture() {
    const texture = new THREE.CanvasTexture(this.atlasCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // No whole-atlas mip pyramid: independent transparent tile margins prevent bleed.
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.anisotropy = this.atlasAnisotropy;
    return texture;
  }

  /**
   * Grow the tile pool to the albums the current library can reference.
   *
   * Only growing: a library refresh that swaps in a bigger library must be able
   * to obtain a tile for every album it can show, while shrinking would throw
   * away surface the atlas may still be asked for. Called from reset(), where no
   * live tile exists to preserve.
   */
  private sizeTo(capacity: number) {
    const next = Math.max(1, Math.min(this.slotCount, capacity));
    if (next <= this.tileCount) return;
    this.tileCount = next;
    this.rows = Math.ceil(next / this.columns);
    this.atlasCanvas.width = this.columns * this.tileWidth;
    this.atlasCanvas.height = this.rows * this.tileHeight;
    this.tileKeys = Array(next);
    this.tileRefs = new Int32Array(next);
    this.atlas.dispose();
    this.atlas = this.createAtlasTexture();
    const material = this.array.material as THREE.MeshLambertMaterial;
    material.map = this.atlas;
    material.needsUpdate = true;
  }

  private loadImage(url?: string) {
    if (!url) return Promise.resolve(undefined);
    let pending = this.images.get(url);
    if (!pending) {
      pending = this.decodeThumbnail(url).then((image) => {
        if (image) this.resolved.set(url, image);
        return image;
      });
      this.images.set(url, pending);
      if (this.images.size > IMAGE_CACHE_LIMIT)
        this.images.delete(this.images.keys().next().value!);
    }
    return pending;
  }

  /**
   * Decode and downscale off the main thread.
   *
   * Scaling a multi-megapixel cover down to a thumbnail inside drawImage() blocks
   * the main thread for milliseconds per cover; a lane switch asks for a whole
   * column of new covers at once, so that work landed as one burst exactly when
   * the camera started moving. createImageBitmap does the resize on a worker
   * thread, leaving the main thread only the small tile paint. The <img> path
   * remains as a fallback for sources fetch() cannot read.
   */
  private async decodeThumbnail(url: string): Promise<CoverImage | undefined> {
    try {
      const response = await fetch(url, { credentials: "omit" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const width = bitmap.width,
        height = bitmap.height;
      const scale = Math.min(1, MAX_THUMBNAIL / Math.max(width, height));
      if (scale >= 1) return { source: bitmap, width, height };
      const resized = await createImageBitmap(blob, {
        resizeWidth: Math.max(1, Math.round(width * scale)),
        resizeHeight: Math.max(1, Math.round(height * scale)),
        resizeQuality: "high",
      });
      bitmap.close();
      return { source: resized, width, height };
    } catch {
      return this.decodeThumbnailWithImageElement(url);
    }
  }

  /** Fallback for cover sources that fetch() cannot read (e.g. cross-origin). */
  private async decodeThumbnailWithImageElement(url: string): Promise<CoverImage | undefined> {
    try {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = url;
      await image.decode();
      // Retain bounded thumbnails, not decoded multi-megapixel source art.
      const width = image.naturalWidth,
        height = image.naturalHeight;
      const scale = Math.min(1, MAX_THUMBNAIL / Math.max(width, height));
      const source = document.createElement("canvas");
      source.width = Math.max(1, Math.round(width * scale));
      source.height = Math.max(1, Math.round(height * scale));
      source
        .getContext("2d")!
        .drawImage(image, 0, 0, source.width, source.height);
      image.src = "";
      return { source, width, height };
    } catch {
      return undefined;
    }
  }

  setSlot(slot: number, record: ArchiveRecord | undefined) {
    // Description/metadata refreshes replace record objects without changing
    // their print. Cache only the visual identity, not the object reference.
    let key = record ? this.recordKeys.get(record) : "";
    if (record && key === undefined) {
      key = JSON.stringify([record.id, record.album?.coverUrl, record.title]);
      this.recordKeys.set(record, key);
    }
    if (this.slotKeys[slot] === key) return;
    this.slotKeys[slot] = key;
    // Release this slot's previous tile before taking a new one. The tile pool is
    // sized to poolAlbumCapacity(), which bounds the distinct albums the pool can
    // reference, so a released tile always covers the album arriving next and
    // allocation cannot fail.
    const previous = this.slotTile[slot];
    if (previous >= 0) {
      this.slotTile[slot] = -1;
      if (--this.tileRefs[previous] === 0) {
        // Nothing shows this album any more: drop the mapping so the tile can be
        // repainted for whichever album arrives next.
        this.tileOf.delete(this.tileKeys[previous]!);
        this.tileKeys[previous] = undefined;
        this.freeTiles.push(previous);
      }
    }
    if (!key) {
      this.writeTile(slot, -1);
      return;
    }
    let tile = this.tileOf.get(key);
    if (tile === undefined) {
      const free = this.freeTiles.pop();
      if (free === undefined) {
        // Unreachable while the pool is the only consumer; leave the slot empty
        // rather than overwrite a tile another album is still using.
        this.writeTile(slot, -1);
        return;
      }
      tile = free;
      this.tileOf.set(key, tile);
      this.tileKeys[tile] = key;
      this.paintTile(tile, record, key);
    }
    this.tileRefs[tile]++;
    this.slotTile[slot] = tile;
    this.writeTile(slot, tile);
  }

  /** Paint one album into its tile; the atlas uploads only when this runs. */
  private paintTile(
    tile: number,
    record: ArchiveRecord | undefined,
    key: string,
  ) {
    const generation = this.generation;
    const draw = (image?: CoverImage) => {
      if (
        this.disposed ||
        generation !== this.generation ||
        this.tileKeys[tile] !== key
      )
        return;
      paintCover(this.tileCanvas, record, image);
      const x = (tile % this.columns) * this.tileWidth;
      const y = Math.floor(tile / this.columns) * this.tileHeight;
      const context = this.atlasCanvas.getContext("2d")!;
      context.clearRect(x, y, this.tileWidth, this.tileHeight);
      context.drawImage(this.tileCanvas, x, y);
      this.atlas.needsUpdate = true;
    };
    // A decoded thumbnail paints straight into the tile: one paint, one upload,
    // and no placeholder frame for artwork the session already holds.
    const url = record?.album?.coverUrl;
    const ready = url ? this.resolved.get(url) : undefined;
    if (ready) {
      draw(ready);
      return;
    }
    draw();
    void this.loadImage(url).then(draw);
  }

  /** Point one instance at a tile, or make it degenerate when there is none. */
  private writeTile(slot: number, tile: number) {
    const offsets = this.tileAttribute.array as Float32Array;
    if (tile < 0) {
      offsets[slot * 4] = 0;
      offsets[slot * 4 + 1] = 0;
      offsets[slot * 4 + 2] = 0;
      offsets[slot * 4 + 3] = 0;
    } else {
      offsets[slot * 4] = (tile % this.columns) / this.columns;
      offsets[slot * 4 + 1] =
        1 - (Math.floor(tile / this.columns) + 1) / this.rows;
      offsets[slot * 4 + 2] = 1 / this.columns;
      offsets[slot * 4 + 3] = 1 / this.rows;
    }
    // 432 instances x 4 floats is 6.9 kB per update, against 108 MB for one
    // atlas upload, so this is the cheap half of the trade by three orders.
    this.tileAttribute.needsUpdate = true;
  }

  async select(record: ArchiveRecord | undefined) {
    this.selectedRecord = record;
    const generation = this.generation;
    const url = record?.album?.coverUrl;
    const ready = url ? this.resolved.get(url) : undefined;
    if (ready) {
      paintCover(this.selectedCanvas, record, ready);
      this.selectedTexture.needsUpdate = true;
      return;
    }
    paintCover(this.selectedCanvas, record);
    this.selectedTexture.needsUpdate = true;
    const image = await this.loadImage(url);
    if (
      this.disposed ||
      generation !== this.generation ||
      this.selectedRecord !== record
    )
      return;
    paintCover(this.selectedCanvas, record, image);
    this.selectedTexture.needsUpdate = true;
  }

  snapshot(mesh: THREE.Mesh) {
    const canvas = document.createElement("canvas");
    canvas.width = this.selectedCanvas.width;
    canvas.height = this.selectedCanvas.height;
    canvas.getContext("2d")!.drawImage(this.selectedCanvas, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.selectedTexture.anisotropy;
    mesh.material = this.selected.material.clone();
    mesh.material.onBeforeCompile = this.selected.material.onBeforeCompile;
    mesh.material.customProgramCacheKey = this.selected.material.customProgramCacheKey;
    (mesh.material as THREE.MeshLambertMaterial).map = texture;
    const record = this.selectedRecord;
    mesh.userData.coverDisposed = false;
    void this.loadImage(record?.album?.coverUrl).then((image) => {
      if (mesh.userData.coverDisposed || this.disposed) return;
      paintCover(canvas, record, image);
      texture.needsUpdate = true;
    });
  }

  reset() {
    // A refreshed library can be larger than the one the atlas was sized for.
    this.sizeTo(poolAlbumCapacity(this.poolRows));
    this.generation++;
    this.slotKeys.fill(undefined);
    this.tileKeys.fill(undefined);
    this.tileRefs.fill(0);
    this.slotTile.fill(-1);
    this.tileOf.clear();
    this.freeTiles.length = 0;
    for (let i = this.tileCount - 1; i >= 0; i--) this.freeTiles.push(i);
    (this.tileAttribute.array as Float32Array).fill(0);
    this.tileAttribute.needsUpdate = true;
    this.selectedRecord = undefined;
    this.images.clear();
    this.resolved.clear();
  }
  dispose() {
    this.disposed = true;
    this.images.clear();
    this.resolved.clear();
    this.atlas.dispose();
    this.selectedTexture.dispose();
    this.array.geometry.dispose();
    (this.array.material as THREE.Material).dispose();
    this.selected.geometry.dispose();
    this.selected.material.dispose();
  }
}
