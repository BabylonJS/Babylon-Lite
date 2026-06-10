/**
 * Runtime atlas packer — builds a `SpriteAtlas` from a set of in-memory RGBA
 * frames (decoded asset lumps, procedurally generated art, packed glyphs …).
 *
 * This is the runtime-frames analog to `createGridSpriteAtlas` (which slices an
 * existing grid texture): here the caller supplies each frame's pixels and the
 * packer shelf-packs them into one texture, uploads it, and emits the matching
 * `SpriteFrame` list. Frames are emitted in **input order** — `result.frames[i]`
 * corresponds to `sources[i]` — so callers can map their own per-frame metadata
 * by index. Each `SpriteFrame.name` carries the source `name` when supplied.
 *
 * Two operations are supported:
 *   - `createSpriteAtlasFromFrames` — build a new atlas. Pre-allocate headroom for
 *     later growth via `options.capacityPx`.
 *   - `appendSpriteAtlasFrames` — pack additional frames into the existing texture
 *     without rebuilding it. Issues one `queue.writeTexture` per frame; the GPU
 *     texture, its view, and any bind groups that reference it remain valid.
 *
 * Sub-rect sources: every `SpriteAtlasFrameSource` may describe a sub-rectangle of a
 * larger pixel buffer via `srcX` / `srcY` / `srcStrideBytes`. This lets callers feed
 * e.g. a freshly rasterized glyph straight from a wasm memory view into the atlas
 * without first copying out the trimmed sub-rect.
 *
 * Tree-shaken: importing this drags in nothing a plain sprite scene pays for.
 */
import { U8 } from "../../engine/typed-arrays.js";
import type { EngineContext } from "../../engine/engine.js";
import { createTexture2DFromPixels } from "../../texture/pixels-texture.js";
import type { SpriteAtlas, SpriteAtlasPackState, SpriteFrame, SpriteSampling } from "./sprite-atlas.js";

/** One source frame for `createSpriteAtlasFromFrames` / `appendSpriteAtlasFrames`. The packed
 *  region is `width × height` texels. By default the source is read as a tightly-packed RGBA8
 *  buffer of exactly that size starting at byte 0; the optional `srcX` / `srcY` / `srcStrideBytes`
 *  fields let the source describe a sub-rectangle of a larger buffer without forcing the caller
 *  to copy out the sub-rect first. */
export interface SpriteAtlasFrameSource {
    /** RGBA8 bytes, row-major, top-to-bottom, straight alpha. When `srcX` / `srcY` /
     *  `srcStrideBytes` are all defaulted, this must be exactly `width * height * 4` bytes;
     *  when sub-rect fields are supplied, it must be large enough to cover the rect
     *  (see those fields' docs). */
    readonly pixels: Uint8Array;
    /** Width of the frame to pack (texels written to the atlas). */
    readonly width: number;
    /** Height of the frame to pack (texels written to the atlas). */
    readonly height: number;
    /** Top-left x of the sub-rect to pack, in texels into `pixels`. Default `0`. */
    readonly srcX?: number;
    /** Top-left y of the sub-rect to pack, in texels into `pixels`. Default `0`. */
    readonly srcY?: number;
    /** Bytes between consecutive rows of `pixels`. Default `width * 4` (tightly packed).
     *  Must satisfy `(srcX + width) * 4 <= srcStrideBytes` — i.e. each row's sub-rect window
     *  must fit within one stride, so reads do not spill into the next row. */
    readonly srcStrideBytes?: number;
    /** Pivot in [0,1] of the frame. Default `[0.5, 0.5]`. */
    readonly pivot?: readonly [number, number];
    /** Recorded on the emitted `SpriteFrame.name`. */
    readonly name?: string;
}

/** Options for `createSpriteAtlasFromFrames`. */
export interface SpriteAtlasPackOptions {
    /** Transparent gap (px) between packed frames; guards against bilinear bleed. Default `1`. */
    paddingPx?: number;
    /** Shelf width (px) before wrapping to a new row. Default `1024`. */
    maxWidthPx?: number;
    /** Min/mag filter for the packed texture. Default `"nearest"`. */
    sampling?: SpriteSampling;
    premultipliedAlpha?: boolean;
    /** Pre-allocate the atlas texture at this `[width, height]` regardless of initial-content
     *  size, leaving headroom for later `appendSpriteAtlasFrames` calls (which never grow the
     *  texture). Required when `sources` is empty. Defaults to the size required by the initial
     *  `sources` (no append headroom). */
    capacityPx?: readonly [number, number];
}

/** @internal Result of `shelfPack`: per-frame placements + the updated shelf cursor. */
interface ShelfPackResult {
    xs: number[];
    ys: number[];
    penX: number;
    penY: number;
    shelfHeight: number;
    /** Right-most x-extent reached during packing — only meaningful for sizing a fresh atlas. */
    contentWidth: number;
    /** Bottom-most y-extent reached during packing — only meaningful for sizing a fresh atlas. */
    contentHeight: number;
}

/** @internal Shelf-pack `sources` starting at the given cursor. Validates each source's pixel
 *  buffer (incl. sub-rect bounds) before placing it. `maxHeight` is the hard ceiling that
 *  triggers an "atlas full" error on overflow — pass `Number.MAX_SAFE_INTEGER` during initial
 *  sizing to defer the cap to the caller-resolved atlas height. */
function shelfPack(
    sources: readonly SpriteAtlasFrameSource[],
    padding: number,
    maxWidth: number,
    maxHeight: number,
    startPenX: number,
    startPenY: number,
    startShelfHeight: number,
    fnLabel: string
): ShelfPackResult {
    const xs = new Array<number>(sources.length);
    const ys = new Array<number>(sources.length);
    let penX = startPenX;
    let penY = startPenY;
    let shelfHeight = startShelfHeight;
    let contentWidth = 0;

    for (let i = 0; i < sources.length; i++) {
        const s = sources[i]!;
        if (s.width < 1 || s.height < 1) {
            throw new Error(`${fnLabel}: frame ${i} has non-positive size ${s.width}x${s.height}.`);
        }
        const srcX = s.srcX ?? 0;
        const srcY = s.srcY ?? 0;
        const srcStride = s.srcStrideBytes ?? s.width * 4;
        if (srcX < 0 || srcY < 0) {
            throw new Error(`${fnLabel}: frame ${i} has negative sub-rect origin (srcX=${srcX}, srcY=${srcY}).`);
        }
        // Each row's read window is `[srcX*4, (srcX+width)*4)` bytes inside one `srcStride`-byte row.
        // The window must fit within the stride, otherwise per-row reads spill into the *next* row's
        // start and produce silently-corrupt uploads. Subsumes the looser `srcStride >= width*4` check
        // (which only handled the srcX=0 case).
        if ((srcX + s.width) * 4 > srcStride) {
            throw new Error(
                `${fnLabel}: frame ${i} sub-rect row extent (srcX + width) * 4 = ${(srcX + s.width) * 4} exceeds srcStrideBytes ${srcStride} (would spill into next row).`
            );
        }
        // Last byte we need to read = (srcY + height - 1) * srcStride + (srcX + width) * 4.
        const requiredBytes = (srcY + s.height - 1) * srcStride + (srcX + s.width) * 4;
        if (s.pixels.length < requiredBytes) {
            throw new Error(
                `${fnLabel}: frame ${i} pixel buffer too short — need ${requiredBytes} bytes ` +
                    `(srcX=${srcX}, srcY=${srcY}, srcStride=${srcStride}, w=${s.width}, h=${s.height}), got ${s.pixels.length}.`
            );
        }
        // Wrap to a new shelf if this frame doesn't fit on the current one.
        if (penX > 0 && penX + s.width > maxWidth) {
            penY += shelfHeight + padding;
            penX = 0;
            shelfHeight = 0;
        }
        if (s.width > maxWidth) {
            throw new Error(`${fnLabel}: frame ${i} width ${s.width} exceeds shelf max width ${maxWidth}.`);
        }
        if (penY + s.height > maxHeight) {
            throw new Error(`${fnLabel}: cannot fit frame ${i} (${s.width}x${s.height}) — atlas height capacity ${maxHeight} exhausted at y=${penY}.`);
        }
        xs[i] = penX;
        ys[i] = penY;
        const rightEdge = penX + s.width;
        if (rightEdge > contentWidth) {
            contentWidth = rightEdge;
        }
        penX = rightEdge + padding;
        if (s.height > shelfHeight) {
            shelfHeight = s.height;
        }
    }

    const contentHeight = sources.length === 0 ? startPenY : penY + shelfHeight;
    return { xs, ys, penX, penY, shelfHeight, contentWidth, contentHeight };
}

/**
 * Pack `sources` into a single `SpriteAtlas`. Shelf-packs in input order: each
 * frame is placed left-to-right on the current shelf, wrapping to a new shelf
 * (row) when it would overflow `maxWidthPx`. The texture is sized exactly to the
 * packed content unless `options.capacityPx` is supplied to reserve headroom for
 * later `appendSpriteAtlasFrames` calls.
 *
 * Pass `sources: []` together with `options.capacityPx` to create an empty atlas
 * sized for future appends.
 */
export function createSpriteAtlasFromFrames(engine: EngineContext, sources: readonly SpriteAtlasFrameSource[], options: SpriteAtlasPackOptions = {}): SpriteAtlas {
    const padding = options.paddingPx ?? 1;
    const requestedMaxWidth = options.maxWidthPx ?? 1024;

    if (sources.length === 0 && !options.capacityPx) {
        throw new Error(
            "createSpriteAtlasFromFrames: at least one frame is required, or pass options.capacityPx to create an empty atlas with reserved capacity for appendSpriteAtlasFrames."
        );
    }

    // When `capacityPx` is supplied, clamp the shelf width to the texture width so packing
    // honors the actual atlas bound (matching what `appendSpriteAtlasFrames` does later).
    // Otherwise a `maxWidthPx` wider than `capacityPx[0]` lets frames flow past the texture's
    // right edge and we'd reject the atlas as "too small" even though a narrower shelf would
    // have wrapped the frames vertically and fit them.
    const maxWidth = options.capacityPx ? Math.min(requestedMaxWidth, options.capacityPx[0]) : requestedMaxWidth;

    // Pack against an unbounded height first so we can discover the content footprint and
    // then decide the final texture dimensions (content-fit vs. caller-supplied capacity).
    const placement = shelfPack(sources, padding, maxWidth, Number.MAX_SAFE_INTEGER, 0, 0, 0, "createSpriteAtlasFromFrames");

    const atlasWidth = options.capacityPx ? options.capacityPx[0] : Math.max(1, placement.contentWidth);
    const atlasHeight = options.capacityPx ? options.capacityPx[1] : Math.max(1, placement.contentHeight);
    if (atlasWidth < 1 || atlasHeight < 1) {
        throw new Error(`createSpriteAtlasFromFrames: atlas dimensions must be >= 1 (got ${atlasWidth}x${atlasHeight}).`);
    }
    if (placement.contentWidth > atlasWidth || placement.contentHeight > atlasHeight) {
        throw new Error(`createSpriteAtlasFromFrames: capacityPx ${atlasWidth}x${atlasHeight} too small for initial content ${placement.contentWidth}x${placement.contentHeight}.`);
    }

    // Composite every initial frame into one transparent RGBA8 buffer sized to the full atlas
    // capacity (which may be larger than the content footprint when capacityPx is set).
    const data = new U8(atlasWidth * atlasHeight * 4);
    for (let i = 0; i < sources.length; i++) {
        const s = sources[i]!;
        const srcX = s.srcX ?? 0;
        const srcY = s.srcY ?? 0;
        const srcStride = s.srcStrideBytes ?? s.width * 4;
        const rowBytes = s.width * 4;
        for (let row = 0; row < s.height; row++) {
            const srcOffset = (srcY + row) * srcStride + srcX * 4;
            const dstOffset = ((placement.ys[i]! + row) * atlasWidth + placement.xs[i]!) * 4;
            data.set(s.pixels.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
        }
    }

    const sampling: SpriteSampling = options.sampling ?? "nearest";
    const texture = createTexture2DFromPixels(engine, data, atlasWidth, atlasHeight, {
        minFilter: sampling,
        magFilter: sampling,
    });

    const frames = new Array<SpriteFrame>(sources.length);
    for (let i = 0; i < sources.length; i++) {
        const s = sources[i]!;
        frames[i] = {
            name: s.name,
            uvMin: [placement.xs[i]! / atlasWidth, placement.ys[i]! / atlasHeight],
            uvMax: [(placement.xs[i]! + s.width) / atlasWidth, (placement.ys[i]! + s.height) / atlasHeight],
            sourceSizePx: [s.width, s.height],
            pivot: s.pivot ?? [0.5, 0.5],
        };
    }

    // Attach packer state so future appendSpriteAtlasFrames calls can resume shelf-packing.
    // `_packState` and `_frames` are `@internal` on the SpriteAtlas type — `frames` stays
    // `readonly` to public consumers, while `_frames` aliases the same array so the packer
    // can push to it without casting.
    const packState: SpriteAtlasPackState = {
        penX: placement.penX,
        penY: placement.penY,
        shelfHeight: placement.shelfHeight,
        maxWidth,
        padding,
    };
    return {
        texture,
        textureSizePx: [atlasWidth, atlasHeight],
        frames,
        premultipliedAlpha: options.premultipliedAlpha ?? false,
        _packState: packState,
        _frames: frames,
    };
}

/**
 * Append `sources` into the remaining free space of an atlas previously built by
 * `createSpriteAtlasFromFrames`. The existing `GPUTexture` (and any bind group already
 * referencing it) stays valid — each new frame is uploaded with a single
 * `queue.writeTexture` and the UV slots of the *existing* frames are not touched, so
 * sprite instances already drawing from this atlas remain correct.
 *
 * Returns the integer indices of the newly-appended frames in `atlas.frames`, in input
 * order. Sources are validated and placed before any texel is written, so a thrown
 * "atlas full" error leaves the atlas state untouched (all-or-nothing semantics).
 *
 * Throws when:
 *   - The atlas was built by `createGridSpriteAtlas` / `loadSpriteAtlas` (no packer state).
 *   - Any source has invalid size / sub-rect / pixel buffer length.
 *   - A source wider than `maxWidthPx` is supplied (cannot fit any shelf).
 *   - The packed sources would overflow the atlas height. Pre-size the atlas via
 *     `createSpriteAtlasFromFrames(engine, [...], { capacityPx: [w, h] })` to reserve room.
 */
export function appendSpriteAtlasFrames(engine: EngineContext, atlas: SpriteAtlas, sources: readonly SpriteAtlasFrameSource[]): number[] {
    if (sources.length === 0) {
        return [];
    }
    const state = atlas._packState;
    const framesOut = atlas._frames;
    if (!state || !framesOut) {
        throw new Error("appendSpriteAtlasFrames: atlas was not built by createSpriteAtlasFromFrames (no packer state).");
    }
    const [atlasW, atlasH] = atlas.textureSizePx;
    const shelfMaxWidth = Math.min(state.maxWidth, atlasW);

    // Phase 1: validate every source and compute placements; throws before mutating anything.
    const placement = shelfPack(sources, state.padding, shelfMaxWidth, atlasH, state.penX, state.penY, state.shelfHeight, "appendSpriteAtlasFrames");

    // Phase 2: commit — upload texels and append SpriteFrame entries. `framesOut` is the same
    // array `atlas.frames` exposes — appending here keeps existing frame references and indices
    // stable for consumers already drawing from this atlas.
    const device = engine._device;
    const texture = atlas.texture.texture;
    const baseIndex = framesOut.length;
    const newIndices = new Array<number>(sources.length);

    for (let i = 0; i < sources.length; i++) {
        const s = sources[i]!;
        const srcX = s.srcX ?? 0;
        const srcY = s.srcY ?? 0;
        const srcStride = s.srcStrideBytes ?? s.width * 4;
        // writeTexture's dataLayout.offset is added on top of the typed array's own byteOffset,
        // so we can hand WebGPU the full source buffer and let it walk the sub-rect directly —
        // no intermediate copy.
        const dataOffset = srcY * srcStride + srcX * 4;
        device.queue.writeTexture(
            { texture, origin: { x: placement.xs[i]!, y: placement.ys[i]! } },
            // Cast `Uint8Array<ArrayBufferLike>` → `Uint8Array<ArrayBuffer>` so the WebGPU
            // `GPUAllowSharedBufferSource` overload accepts it. `pixels` is supplied by the caller
            // as plain bytes (we never construct it from a `SharedArrayBuffer`), so this is sound.
            s.pixels as Uint8Array<ArrayBuffer>,
            { offset: dataOffset, bytesPerRow: srcStride, rowsPerImage: s.height },
            { width: s.width, height: s.height }
        );
        newIndices[i] = baseIndex + i;
        framesOut.push({
            name: s.name,
            uvMin: [placement.xs[i]! / atlasW, placement.ys[i]! / atlasH],
            uvMax: [(placement.xs[i]! + s.width) / atlasW, (placement.ys[i]! + s.height) / atlasH],
            sourceSizePx: [s.width, s.height],
            pivot: s.pivot ?? [0.5, 0.5],
        });
    }

    state.penX = placement.penX;
    state.penY = placement.penY;
    state.shelfHeight = placement.shelfHeight;

    return newIndices;
}
