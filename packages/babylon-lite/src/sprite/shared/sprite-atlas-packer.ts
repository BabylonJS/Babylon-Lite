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
 * Tree-shaken: importing this drags in nothing a plain sprite scene pays for.
 */
import type { EngineContext } from "../../engine/engine.js";
import { createTexture2DFromPixels } from "../../texture/pixels-texture.js";
import type { SpriteAtlas, SpriteFrame, SpriteSampling } from "./sprite-atlas.js";

/** One source frame for `createSpriteAtlasFromFrames`. */
export interface SpriteAtlasFrameSource {
    /** Tightly packed RGBA8 bytes — `width * height * 4`, row-major, top-to-bottom, straight alpha. */
    readonly pixels: Uint8Array;
    readonly width: number;
    readonly height: number;
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
}

/**
 * Pack `sources` into a single `SpriteAtlas`. Shelf-packs in input order: each
 * frame is placed left-to-right on the current shelf, wrapping to a new shelf
 * (row) when it would overflow `maxWidthPx`. The texture is sized exactly to the
 * packed content.
 */
export function createSpriteAtlasFromFrames(engine: EngineContext, sources: readonly SpriteAtlasFrameSource[], options: SpriteAtlasPackOptions = {}): SpriteAtlas {
    if (sources.length === 0) {
        throw new Error("createSpriteAtlasFromFrames: at least one frame is required.");
    }
    const padding = options.paddingPx ?? 1;
    const maxWidth = options.maxWidthPx ?? 1024;

    // Shelf-pack in input order; record each frame's top-left into xs/ys.
    const xs = new Array<number>(sources.length);
    const ys = new Array<number>(sources.length);
    let penX = 0;
    let penY = 0;
    let shelfHeight = 0;
    let atlasWidth = 1;
    for (let i = 0; i < sources.length; i++) {
        const s = sources[i]!;
        if (s.width < 1 || s.height < 1) {
            throw new Error(`createSpriteAtlasFromFrames: frame ${i} has non-positive size ${s.width}x${s.height}.`);
        }
        if (s.pixels.length < s.width * s.height * 4) {
            throw new Error(`createSpriteAtlasFromFrames: frame ${i} pixel buffer too short — need ${s.width * s.height * 4} bytes, got ${s.pixels.length}.`);
        }
        if (penX > 0 && penX + s.width > maxWidth) {
            penY += shelfHeight + padding;
            penX = 0;
            shelfHeight = 0;
        }
        xs[i] = penX;
        ys[i] = penY;
        const rightEdge = penX + s.width;
        if (rightEdge > atlasWidth) {
            atlasWidth = rightEdge;
        }
        penX = rightEdge + padding;
        if (s.height > shelfHeight) {
            shelfHeight = s.height;
        }
    }
    const atlasHeight = penY + shelfHeight;

    // Composite every frame into one transparent RGBA8 buffer.
    const data = new Uint8Array(atlasWidth * atlasHeight * 4);
    for (let i = 0; i < sources.length; i++) {
        const s = sources[i]!;
        const rowBytes = s.width * 4;
        for (let row = 0; row < s.height; row++) {
            const srcOffset = row * rowBytes;
            const dstOffset = ((ys[i]! + row) * atlasWidth + xs[i]!) * 4;
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
            uvMin: [xs[i]! / atlasWidth, ys[i]! / atlasHeight],
            uvMax: [(xs[i]! + s.width) / atlasWidth, (ys[i]! + s.height) / atlasHeight],
            sourceSizePx: [s.width, s.height],
            pivot: s.pivot ?? [0.5, 0.5],
        };
    }

    return {
        texture,
        textureSizePx: [atlasWidth, atlasHeight],
        frames,
        premultipliedAlpha: options.premultipliedAlpha ?? false,
    };
}
