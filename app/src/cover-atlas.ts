import * as THREE from "three";
import type { MusicSelectionLighting } from "./music-lighting";
import type { ArchiveRecord } from "./data";
import { MUSIC_COVER, createAlbumPrintMaterial } from "./music-model.ts";
import { poolAlbumCapacity, LOOP_ROWS } from "./archive-loop.ts";

// Print on the glass surface. No transmitting/frosted layer sits over the image.
export const COVER_SIZE = MUSIC_COVER;
/** `width`/`height` are the source artwork's own size; `source` is the decode. */
type CoverImage = { source: HTMLCanvasElement | ImageBitmap | HTMLImageElement; width: number; height: number };
export const COVER_PAINT_SIZE = 1024;
/**
 * The detail canvas is COVER_PAINT_SIZE. Tiles are `tileWidth` — 256 in
 * practice, and never more than a quarter of this — so one decoded thumbnail
 * cannot serve both.
 *
 * Decoding at 1024 to paint a 256 px tile costs sixteen times the pixels of the
 * artwork that actually reaches the screen, and every album the shelf can reach
 * paid it. This library's largest cover is 4000 x 4000 (16 MP, 64 MB decoded),
 * so a lane switch that brings a whole shelf into the pool asked for ~79 such
 * decodes at once. The two tiers below are what stop that: the shelf reads a
 * thumbnail sized to its own tile, and the full-size decode is paid once, for
 * the album the user actually opened.
 */
const DETAIL_THUMBNAIL = COVER_PAINT_SIZE;
/**
 * Cache bounds, counted in decoded RGBA bytes rather than entries.
 *
 * The old bound was a flat 96 entries; at 1024 px each that is ~402 MB of
 * resident bitmaps, which makes a garbage-collection pause the most plausible
 * explanation for a stutter that arrives "sometimes, unpredictably". Bytes are
 * the quantity that actually matters, and a 256 px tile is only 262 kB, so a
 * 79-album library now fits with room to spare instead of sitting at the limit.
 */
const TILE_CACHE_BYTES = 48 * 1024 * 1024;
const DETAIL_CACHE_BYTES = 40 * 1024 * 1024;
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

/**
 * Intrinsic size of an encoded image, read from its header.
 *
 * Why not simply decode: `createImageBitmap` cannot be told "decode, but report
 * the aspect ratio first", so preserving an aspect while resizing needs the
 * dimensions before the resample. The obvious route — decode once to measure,
 * then decode again to resize — parses the JPEG twice and materialises the full
 * 16 MP bitmap on the way to an image that ends up 256 px wide. Reading a few
 * dozen header bytes costs nothing by comparison, and lets the decoder be asked
 * for the final size directly.
 *
 * `undefined` is a supported outcome: an unrecognised container falls back to a
 * decode-measure-resample path in the caller.
 */
export function imageSizeFromHeader(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (count: number) => bytes.length >= count;
  // PNG: 8-byte signature, then the IHDR chunk's width/height, big-endian.
  if (has(24) && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return { width: view.getUint32(16), height: view.getUint32(20) };
  // GIF87a / GIF89a: logical screen size, little-endian.
  if (has(10) && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  // BMP: BITMAPINFOHEADER's biWidth/biHeight, signed (a negative height means the
  // rows are stored top-down), little-endian.
  if (has(26) && bytes[0] === 0x42 && bytes[1] === 0x4d)
    return {
      width: Math.abs(view.getInt32(18, true)),
      height: Math.abs(view.getInt32(22, true)),
    };
  // WebP: a RIFF container whose fourth chunk id says how the canvas is described.
  if (
    has(16) &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === "VP8X" && has(30))
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    if (chunk === "VP8L" && has(25)) {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && has(30))
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
  }
  // JPEG: skip the segment chain to the first Start-Of-Frame, the only segment
  // that carries the dimensions.
  if (has(4) && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      // Standalone markers carry no length field.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      // SOF0–SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return {
          height: (bytes[offset + 5] << 8) | bytes[offset + 6],
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
        };
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return undefined;
}

export function paintCover(
  canvas: HTMLCanvasElement,
  record: Pick<ArchiveRecord, "title"> | undefined,
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

/** Decoded size of a retained thumbnail, which is what the budget bounds. */
const footprint = (image: CoverImage) =>
  Math.max(1, image.source.width) * Math.max(1, image.source.height) * 4;

/** An ImageBitmap holds memory outside the JS heap and has to be released. */
function releaseImage(image: CoverImage) {
  const source = image.source;
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) source.close();
}

/**
 * A thumbnail cache bounded by decoded bytes.
 *
 * Eviction drops the reference rather than closing the bitmap: a bitmap already
 * handed to a caller may be mid-paint, and closing it there would throw inside
 * `drawImage`. Every hard release — a library refresh, a disposal — does close,
 * so nothing outlives the atlas for long.
 */
class ThumbnailCache {
  private readonly ready = new Map<string, CoverImage>();
  private readonly pending = new Map<string, Promise<CoverImage | undefined>>();
  private bytes = 0;
  private readonly budget: number;

  // An explicit field rather than a parameter property: Node's strip-only
  // TypeScript loader, which the check scripts run under, rejects the shorthand.
  constructor(budget: number) {
    this.budget = budget;
  }

  /** True once a decode has been started, whether or not it has resolved. */
  has(url: string) {
    return this.pending.has(url);
  }

  peek(url: string) {
    return this.ready.get(url);
  }

  load(url: string, decode: (url: string) => Promise<CoverImage | undefined>) {
    const inFlight = this.pending.get(url);
    if (inFlight) return inFlight;
    const promise = decode(url).then((image) => {
      if (image) this.retain(url, image);
      return image;
    });
    this.pending.set(url, promise);
    return promise;
  }

  private retain(url: string, image: CoverImage) {
    const previous = this.ready.get(url);
    if (previous) this.bytes -= footprint(previous);
    this.ready.set(url, image);
    this.bytes += footprint(image);
    while (this.bytes > this.budget && this.ready.size > 1) {
      const oldest = this.ready.keys().next().value;
      if (oldest === undefined) break;
      const dropped = this.ready.get(oldest)!;
      this.ready.delete(oldest);
      this.bytes -= footprint(dropped);
    }
  }

  clear() {
    for (const image of this.ready.values()) releaseImage(image);
    this.ready.clear();
    this.pending.clear();
    this.bytes = 0;
  }

  get decodedBytes() {
    return this.bytes;
  }
}

/**
 * Where a tile's rows land in the atlas texture, for a sub-rectangle upload.
 *
 * three.js uploads a canvas with `UNPACK_FLIP_Y_WEBGL` set, so canvas row 0 —
 * the *top* — becomes the texture's last row. A `texSubImage2D` at an offset
 * flips only its own block, so a tile has to be placed at the mirrored row:
 * canvas row `y` maps to texture row `H - 1 - y`, and a block of height `h`
 * therefore starts at `H - h - y`.
 *
 * The existing UV maths in `writeTile` arrives at the same place by another
 * route — it puts the tile's v-origin at `1 - (row + 1) / rows`, i.e. texture
 * rows `[H - (row + 1) * h, H - row * h)`, which is exactly `atlasSubRectY` of
 * canvas row `row * h`. Two independent derivations agreeing is the only
 * assurance available here, so this is a named function with its own test
 * rather than an inline expression: getting it wrong moves every cover onto
 * another album's artwork.
 */
export function atlasSubRectY(textureHeight: number, blockHeight: number, canvasY: number) {
  return textureHeight - blockHeight - canvasY;
}

/** One recycled snapshot surface: a canvas and the texture that mirrors it. */
interface SnapshotSurface {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
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
  /** Thumbnails sized to a tile, and the larger ones the detail view needs. */
  private readonly tiles = new ThumbnailCache(TILE_CACHE_BYTES);
  private readonly details = new ThumbnailCache(DETAIL_CACHE_BYTES);
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
  /**
   * The pixel size a tile's artwork actually occupies once the UV margin is
   * taken out, so a thumbnail is never decoded larger than it can be shown.
   */
  private readonly tileSource: number;
  // Slot count (the display pool) and the rows each lane spans, kept apart from
  // the tile count so the atlas can be sized to the albums actually reachable.
  private readonly slotCount: number;
  private readonly poolRows: number;
  private readonly atlasAnisotropy: number;
  /** Set by the scene; without it the atlas can only be re-uploaded whole. */
  private renderer?: THREE.WebGLRenderer;
  /** The surfaces handed out by snapshot(), recycled instead of reallocated. */
  private readonly snapshotFree: SnapshotSurface[] = [];
  /** Idle prefetch state; see prefetch(). */
  private prefetchQueue: string[] = [];
  private prefetchHandle = 0;
  private prefetchIdle = false;
  /** Single-flight detail decode; see select(). */
  private detailBusy = false;
  private pendingDetail: { record: ArchiveRecord | undefined; resolve: () => void } | null = null;

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
    this.tileSource = Math.max(1, Math.ceil(this.tileWidth / (1 - COVER_INSET * 2)));
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

  /**
   * Decode sizes and retained bytes, for the diagnostics readout.
   *
   * Exposed rather than merely commented because the claim "the tile tier decodes
   * sixteen times fewer pixels" is exactly the kind of statement that silently
   * stops being true after a refactor.
   */
  get cacheInfo() {
    return {
      tileWidth: this.tileWidth,
      tileSource: this.tileSource,
      detailSource: DETAIL_THUMBNAIL,
      tileBudget: TILE_CACHE_BYTES,
      detailBudget: DETAIL_CACHE_BYTES,
      decodedBytes: this.tiles.decodedBytes + this.details.decodedBytes,
    };
  }

  /**
   * Hand the atlas the renderer, so a tile paint can be uploaded as a
   * sub-rectangle instead of re-uploading the whole surface.
   *
   * `CanvasTexture.needsUpdate = true` re-uploads all of it on the next render
   * — 4096 x 1280 RGBA, about 21 MB. A genre or lane switch brings a whole shelf
   * of new albums into the pool, each needing its own upload, so the naive path
   * measured up to ~48 whole-surface uploads inside one navigation: roughly a
   * gigabyte of texture traffic, and the reason a switch between two different
   * styles still stuttered after the tile-keyed atlas removed the scrolling
   * case. A 256x256 tile is 262 kB, so patching just the changed rectangle is
   * an ~80x reduction.
   *
   * three.js exposes no dirty-rect API for a canvas source, so the tile is
   * pushed at the live texture with `texSubImage2D`. `atlasCanvas` stays the
   * source of truth and is still written, so any whole-surface upload — the
   * first render, a quality change, a grown pool — carries every tile and the
   * fast path can never make the atlas permanently wrong.
   */
  attachRenderer(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
  }

  /**
   * Patch one tile rectangle into the live texture.
   *
   * Returns false when the caller must fall back to a whole-surface upload: no
   * renderer, a lost context, or a texture three.js has not uploaded yet (its
   * `__webglTexture` is only created on first use).
   */
  private uploadTile(x: number, y: number) {
    const renderer = this.renderer;
    if (!renderer || this.disposed) return false;
    const handle = (
      renderer.properties.get(this.atlas) as
        | { __webglTexture?: WebGLTexture | null }
        | undefined
    )?.__webglTexture;
    if (!handle) return false;
    // three.js creates a `webgl2` context and nothing else (its own request, and
    // it throws when the browser cannot supply one), but `getContext()` is typed
    // as the union of both versions, and on that union the source form of
    // `texSubImage2D` — the one three.js itself calls — is not declared. It is
    // declared on `WebGL2RenderingContext`, which is what the context really is.
    const gl = renderer.getContext() as unknown as WebGL2RenderingContext;
    if (gl.isContextLost()) return false;
    // Exactly the pixel-store state three.js sets before it uploads an sRGB
    // canvas, so a patched rectangle is byte-identical to one a whole-surface
    // upload would have written. It re-sets all four on every upload
    // (`uploadTexture`), so leaving them behind is safe.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    // Bound through three.js' own state cache rather than with a raw
    // `gl.bindTexture`: a raw bind leaves the cache believing some other
    // texture is still on this unit, and the next draw would then reuse it.
    renderer.state.bindTexture(gl.TEXTURE_2D, handle);
    // WebGL2's source form: the source is already exactly tile-sized, so asking
    // for that size is a no-op scale rather than a resample.
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      x,
      atlasSubRectY(this.atlasCanvas.height, this.tileHeight, y),
      this.tileWidth,
      this.tileHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.tileCanvas,
    );
    return true;
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

  private loadTile(url?: string) {
    if (!url) return Promise.resolve<CoverImage | undefined>(undefined);
    return this.tiles.load(url, (target) => this.decode(target, this.tileSource));
  }

  private loadDetail(url?: string) {
    if (!url) return Promise.resolve<CoverImage | undefined>(undefined);
    return this.details.load(url, (target) => this.decode(target, DETAIL_THUMBNAIL));
  }

  /**
   * Decode one cover, downscaled to at most `max` on its longer side.
   *
   * Two properties matter here. First, the size is read from the header, so the
   * decoder can be asked for the final dimensions in one pass — the previous
   * code decoded the blob once to measure, then called `createImageBitmap` on
   * the *blob* again, parsing the JPEG a second time and building the full-size
   * bitmap on the way. Second, when the header is unreadable the resample is
   * taken from the decoded bitmap rather than from the blob, which is a resample
   * instead of a second decode.
   *
   * The resize itself still runs on the browser's image threads: scaling inside
   * `drawImage` would block the main thread for milliseconds per cover, and a
   * lane switch asks for a whole shelf at once.
   */
  private async decode(url: string, max: number): Promise<CoverImage | undefined> {
    try {
      const response = await fetch(url, { credentials: "omit" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      // 64 kB covers every header parsed here, and every offset any of them uses.
      const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
      const size = imageSizeFromHeader(head);
      if (size) {
        const scale = Math.min(1, max / Math.max(size.width, size.height));
        if (scale >= 1) {
          const bitmap = await createImageBitmap(blob);
          return { source: bitmap, width: bitmap.width, height: bitmap.height };
        }
        const bitmap = await createImageBitmap(blob, {
          resizeWidth: Math.max(1, Math.round(size.width * scale)),
          resizeHeight: Math.max(1, Math.round(size.height * scale)),
          resizeQuality: "high",
        });
        return { source: bitmap, width: size.width, height: size.height };
      }
      const full = await createImageBitmap(blob);
      const width = full.width,
        height = full.height;
      const scale = Math.min(1, max / Math.max(width, height));
      if (scale >= 1) return { source: full, width, height };
      const resized = await createImageBitmap(full, {
        resizeWidth: Math.max(1, Math.round(width * scale)),
        resizeHeight: Math.max(1, Math.round(height * scale)),
        resizeQuality: "high",
      });
      full.close();
      return { source: resized, width, height };
    } catch {
      return this.decodeWithImageElement(url, max);
    }
  }

  /** Fallback for cover sources that fetch() cannot read (e.g. cross-origin). */
  private async decodeWithImageElement(url: string, max: number): Promise<CoverImage | undefined> {
    try {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = url;
      await image.decode();
      // Retain bounded thumbnails, not decoded multi-megapixel source art.
      const width = image.naturalWidth,
        height = image.naturalHeight;
      const scale = Math.min(1, max / Math.max(width, height));
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

  /**
   * Warm the shelf's thumbnails while nothing is happening.
   *
   * The expensive case is the *first* visit to a genre: none of its albums have
   * a tile yet, so the whole shelf decodes in the moment the camera starts
   * moving. Every one of those decodes is cheaper than before, but it is still
   * work landing in the worst possible frame. Doing it up front, one image per
   * idle slot, moves it to a time when the user is not asking for anything — and
   * because the pool can hold every album in the library, a warmed thumbnail is
   * never evicted in practice.
   *
   * Deliberately serial: this is filler, and two concurrent decodes would
   * compete with whatever the next gesture needs.
   */
  prefetch(records: ArchiveRecord[]) {
    const queued = new Set<string>();
    const next: string[] = [];
    for (const record of records) {
      const url = record?.album?.coverUrl;
      if (!url || queued.has(url)) continue;
      queued.add(url);
      // `has` covers both the decoded and the in-flight case, so a second call
      // never restarts work the first one already paid for.
      if (this.tiles.has(url)) continue;
      next.push(url);
    }
    this.cancelPrefetch();
    this.prefetchQueue = next;
    // A short delay keeps this clear of the boot sequence, which is the only
    // other moment that wants the main thread.
    this.schedulePrefetch(2000);
  }

  private schedulePrefetch(delay: number) {
    if (this.disposed || this.prefetchHandle || !this.prefetchQueue.length) return;
    const pump = () => {
      this.prefetchHandle = 0;
      if (this.disposed) return;
      const url = this.prefetchQueue.shift();
      if (!url) return;
      void this.loadTile(url).then(
        () => this.schedulePrefetch(0),
        () => this.schedulePrefetch(0),
      );
    };
    const idle = (
      globalThis as {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (delay > 0) {
      this.prefetchIdle = false;
      this.prefetchHandle = setTimeout(pump, delay) as unknown as number;
    } else if (idle) {
      this.prefetchIdle = true;
      this.prefetchHandle = idle(pump, { timeout: 1500 });
    } else {
      this.prefetchIdle = false;
      this.prefetchHandle = setTimeout(pump, 90) as unknown as number;
    }
  }

  private cancelPrefetch() {
    if (this.prefetchHandle) {
      const cancelIdle = (globalThis as { cancelIdleCallback?: (handle: number) => void })
        .cancelIdleCallback;
      if (this.prefetchIdle && cancelIdle) cancelIdle(this.prefetchHandle);
      else clearTimeout(this.prefetchHandle);
    }
    this.prefetchHandle = 0;
    this.prefetchIdle = false;
    this.prefetchQueue = [];
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
      // The atlas canvas is written first and stays authoritative, so the
      // fallback below is always correct on its own.
      const context = this.atlasCanvas.getContext("2d")!;
      context.clearRect(x, y, this.tileWidth, this.tileHeight);
      context.drawImage(this.tileCanvas, x, y);
      if (!this.uploadTile(x, y)) this.atlas.needsUpdate = true;
    };
    // A decoded thumbnail paints straight into the tile: one paint, one upload,
    // and no placeholder frame for artwork the session already holds.
    const url = record?.album?.coverUrl;
    const ready = url ? this.tiles.peek(url) : undefined;
    if (ready) {
      draw(ready);
      return;
    }
    draw();
    void this.loadTile(url).then(draw);
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
    const url = record?.album?.coverUrl;
    const ready = url ? this.details.peek(url) : undefined;
    if (ready) {
      this.cancelPendingDetail();
      paintCover(this.selectedCanvas, record, ready);
      this.selectedTexture.needsUpdate = true;
      return;
    }
    // The placeholder goes up straight away, so the switch itself never waits
    // on a decode — the real cover replaces it whenever it lands.
    paintCover(this.selectedCanvas, record);
    this.selectedTexture.needsUpdate = true;
    await this.queueDetail(record);
  }

  /**
   * Decode at most one detail cover at a time, keeping only the newest request.
   *
   * Holding an arrow key fires one `select` per row, and each one used to start
   * its own full-size decode — a 4000x4000 cover is 16 MP, or 64 MB once
   * decoded. Ten rows meant ten of those landing at once, which is exactly the
   * memory churn behind the "sometimes it stutters, sometimes it doesn't"
   * report: whether a spike hurt depended on what else had been decoded.
   *
   * Only the last cover is still wanted by the time it arrives, so this keeps a
   * single decode in flight and a single request waiting. Anything in between is
   * answered immediately and never decoded. A run of any length therefore costs
   * at most two decodes instead of one per step.
   */
  private queueDetail(record: ArchiveRecord | undefined) {
    if (this.disposed) return Promise.resolve();
    this.cancelPendingDetail();
    return new Promise<void>((resolve) => {
      this.pendingDetail = { record, resolve };
      if (!this.detailBusy) void this.pumpDetail();
    });
  }

  private cancelPendingDetail() {
    if (!this.pendingDetail) return;
    const superseded = this.pendingDetail;
    this.pendingDetail = null;
    superseded.resolve();
  }

  private async pumpDetail() {
    if (this.detailBusy) return;
    this.detailBusy = true;
    try {
      while (this.pendingDetail && !this.disposed) {
        const request = this.pendingDetail;
        this.pendingDetail = null;
        const generation = this.generation;
        const image = await this.loadDetail(request.record?.album?.coverUrl);
        // A later step already moved the selection on, or the library was
        // refreshed underneath: this cover is stale, so it is discarded rather
        // than painted over the newer one.
        if (
          this.disposed ||
          generation !== this.generation ||
          this.selectedRecord !== request.record
        ) {
          request.resolve();
          continue;
        }
        paintCover(this.selectedCanvas, request.record, image);
        this.selectedTexture.needsUpdate = true;
        request.resolve();
      }
    } finally {
      this.detailBusy = false;
    }
  }

  /**
   * Hand out a snapshot surface, reusing a retired one when there is one.
   *
   * The outgoing card is a picture of the album the shelf just moved away from;
   * a card is created on every move and disposed when the shelf returns. Each
   * one used to allocate a 1024² canvas, a mipmapped `CanvasTexture` and a label
   * canvas — a fresh ~5 MB upload with mipmap generation, per keystroke.
   * Recycling the surface keeps the shape of the animation and takes the
   * allocation out of the keystroke.
   *
   * Mipmaps are off and linear filtering on: the card is a screen-facing plane
   * seen at one size, so the pyramid was pure cost.
   */
  private acquireSnapshot(): SnapshotSurface {
    const recycled = this.snapshotFree.pop();
    if (recycled) return recycled;
    const canvas = document.createElement("canvas");
    canvas.width = COVER_PAINT_SIZE;
    canvas.height = COVER_PAINT_SIZE;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.selectedTexture.anisotropy;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    return { canvas, texture };
  }

  snapshot(mesh: THREE.Mesh) {
    const surface = this.acquireSnapshot();
    const texture = surface.texture;
    texture.needsUpdate = true;
    mesh.material = this.selected.material.clone();
    mesh.material.onBeforeCompile = this.selected.material.onBeforeCompile;
    mesh.material.customProgramCacheKey = this.selected.material.customProgramCacheKey;
    (mesh.material as THREE.MeshLambertMaterial).map = texture;
    const record = this.selectedRecord;
    mesh.userData.coverDisposed = false;
    mesh.userData.snapshotSurface = surface;
    const context = surface.canvas.getContext("2d")!;
    context.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    context.drawImage(this.selectedCanvas, 0, 0);
    // The outgoing card keeps the art the user was just looking at, so it takes
    // the larger tier and never the tile-sized one.
    void this.loadDetail(record?.album?.coverUrl).then((image) => {
      if (mesh.userData.coverDisposed || this.disposed) return;
      paintCover(surface.canvas, record, image);
      texture.needsUpdate = true;
    });
  }

  /** Return a retired card's surface to the pool. Safe to call twice. */
  releaseSnapshot(group: THREE.Object3D) {
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      const surface = mesh.userData.snapshotSurface as SnapshotSurface | undefined;
      if (!surface) continue;
      mesh.userData.snapshotSurface = undefined;
      this.snapshotFree.push(surface);
    }
  }

  /**
   * v0.4.1 compatibility surface. This atlas uploads each painted tile eagerly
   * (uploadTile inside draw), so there is never a deferred dirty queue to flush;
   * the method still refreshes the renderer reference and reports zero work so
   * the scene's per-frame flush loop becomes a no-op.
   */
  flushUploads(renderer: THREE.WebGLRenderer, _maxTiles = 8) {
    this.renderer = renderer;
    return 0;
  }

  /** v0.4.1 compatibility: visible requests are decoded eagerly, so nothing is pending. */
  async prepareVisible(_timeoutMs = 1200) {
    return { settled: true, ...this.getStats() };
  }

  getStats() {
    return {
      atlasWidth: this.atlasCanvas.width,
      atlasHeight: this.atlasCanvas.height,
      atlasBytes: this.atlasCanvas.width * this.atlasCanvas.height * 4,
      tileWidth: this.tileWidth,
      tileHeight: this.tileHeight,
      activeDecodes: 0,
      queuedDecodes: 0,
      pendingImages: 0,
      peakDecodes: 0,
      cachedImages: 0,
      cachedBytes: this.tiles.decodedBytes + this.details.decodedBytes,
      dirtyTiles: 0,
      uploadedTiles: 0,
      uploadedBytes: 0,
      uploadBatches: 0,
      gpuInitialized: Boolean(this.renderer),
    };
  }

  reset() {
    this.cancelPrefetch();
    this.cancelPendingDetail();
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
    this.tiles.clear();
    this.details.clear();
  }
  dispose() {
    this.disposed = true;
    this.cancelPrefetch();
    this.cancelPendingDetail();
    this.tiles.clear();
    this.details.clear();
    for (const surface of this.snapshotFree) {
      surface.texture.dispose();
      surface.canvas.width = 0;
      surface.canvas.height = 0;
    }
    this.snapshotFree.length = 0;
    this.atlas.dispose();
    this.selectedTexture.dispose();
    this.array.geometry.dispose();
    (this.array.material as THREE.Material).dispose();
    this.selected.geometry.dispose();
    this.selected.material.dispose();
  }
}
