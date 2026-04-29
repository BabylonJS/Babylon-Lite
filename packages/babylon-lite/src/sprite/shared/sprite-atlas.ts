/**
 * Sprite atlas — shared foundation for `Sprite2DLayer` (and, in later PRs,
 * billboards). A `SpriteAtlas` is a pure data record: a `Texture2D` plus
 * an immutable list of `SpriteFrame`s. The same atlas may back multiple
 * layers / scenes; lifetime is governed by the underlying `Texture2D`.
 *
 * PR 1 ships only the grid-based atlas constructor and the loader. Frames
 * are addressed by **integer index only**; a string-keyed wrapper type
 * (analogous to a future `NamedSpriteAtlas`) will land alongside the
 * TexturePacker JSON loader in a later PR.
 *
 * NOT YET IMPLEMENTED (intentionally omitted, see
 * `docs/sprites/pr1-pure-2d-sprites-scope.md`):
 *   - `SpriteClip` / `clips` field on the atlas (animation playback). Will
 *     land as an additive change to `SpriteAtlas` in a follow-up PR.
 */
import type { EngineContext } from "../../engine/engine.js";
import type { Texture2D, Texture2DOptions } from "../../texture/texture-2d.js";
import { loadTexture2D } from "../../texture/texture-2d.js";

/** Texture sampling mode for a sprite atlas. */
export type SpriteSampling = "linear" | "nearest";

/** A single frame in an atlas. UVs in [0,1]; pivot in [0,1] of the frame. */
export interface SpriteFrame {
    readonly name?: string;
    readonly uvMin: readonly [number, number];
    readonly uvMax: readonly [number, number];
    readonly sourceSizePx: readonly [number, number];
    readonly pivot: readonly [number, number];
}

/** A loaded sprite atlas — pure data, no methods. Frames are addressed by integer index. */
export interface SpriteAtlas {
    readonly texture: Texture2D;
    readonly textureSizePx: readonly [number, number];
    readonly frames: readonly SpriteFrame[];
    readonly premultipliedAlpha: boolean;
}

/** Options for `createGridSpriteAtlas`. */
export interface GridAtlasOptions {
    cellWidthPx: number;
    cellHeightPx: number;
    /** Defaults to `floor(textureWidth / cellWidthPx)`. */
    columns?: number;
    /** Defaults to `floor(textureHeight / cellHeightPx)`. */
    rows?: number;
    marginPx?: number;
    spacingPx?: number;
    /** Default `[0.5, 0.5]`. */
    pivot?: readonly [number, number];
    premultipliedAlpha?: boolean;
}

/** Options for `loadSpriteAtlas`. PR 1 supports the `gridSize` path only. */
export interface LoadAtlasOptions {
    /** Grid cell size `[w, h]` in pixels. Required in PR 1. */
    gridSize?: readonly [number, number];
    /** Reserved for future PR — TexturePacker-style JSON. Throws if used in PR 1. */
    metadataUrl?: string;
    sampling?: SpriteSampling;
    /** Marks the atlas as carrying premultiplied RGBA so the renderer picks the
     *  premultiplied blend pipeline (`srcFactor: ONE`). Default `false` — matches
     *  the bits PNG decoding produces. Set together with `premultiplyOnLoad: true`
     *  for mathematically correct soft edges. Setting this `true` without
     *  `premultiplyOnLoad: true` is only correct if the source image is *already*
     *  premultiplied on disk (e.g. produced by a build step). */
    premultipliedAlpha?: boolean;
    /** Tell the texture loader to premultiply alpha at decode time
     *  (`createImageBitmap({ premultiplyAlpha: "premultiply" })`). Default `false`.
     *  Pair with `premultipliedAlpha: true` for the premultiplied blend pipeline. */
    premultiplyOnLoad?: boolean;
    textureOptions?: Texture2DOptions;
}

/**
 * Build a `SpriteAtlas` from a uniform grid over an existing texture. All
 * cells share the supplied pivot. Frames are emitted row-major (top-left
 * first). No name lookup map is populated because grid cells have no names.
 */
export function createGridSpriteAtlas(texture: Texture2D, options: GridAtlasOptions): SpriteAtlas {
    const cellW = options.cellWidthPx;
    const cellH = options.cellHeightPx;
    const margin = options.marginPx ?? 0;
    const spacing = options.spacingPx ?? 0;
    const cols = options.columns ?? Math.max(1, Math.floor((texture.width - margin * 2 + spacing) / (cellW + spacing)));
    const rows = options.rows ?? Math.max(1, Math.floor((texture.height - margin * 2 + spacing) / (cellH + spacing)));
    const pivot = options.pivot ?? [0.5, 0.5];

    const tw = texture.width;
    const th = texture.height;
    const frames: SpriteFrame[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x = margin + c * (cellW + spacing);
            const y = margin + r * (cellH + spacing);
            frames.push({
                uvMin: [x / tw, y / th],
                uvMax: [(x + cellW) / tw, (y + cellH) / th],
                sourceSizePx: [cellW, cellH],
                pivot: [pivot[0], pivot[1]],
            });
        }
    }

    return {
        texture,
        textureSizePx: [tw, th],
        frames,
        premultipliedAlpha: options.premultipliedAlpha ?? false,
    };
}

/**
 * Load a sprite atlas from an image URL. PR 1 supports only the
 * `gridSize` path: the texture is fetched as a non-Y-flipped image
 * (so atlas UVs map top-down with `(0,0)` at the image top-left) and
 * partitioned into a grid via `createGridSpriteAtlas`.
 */
export async function loadSpriteAtlas(engine: EngineContext, textureUrl: string, options: LoadAtlasOptions = {}): Promise<SpriteAtlas> {
    if (options.metadataUrl !== undefined) {
        throw new Error("loadSpriteAtlas: metadataUrl is not implemented in PR 1.");
    }
    if (!options.gridSize) {
        throw new Error("loadSpriteAtlas: options.gridSize is required in PR 1.");
    }

    const texOpts: Texture2DOptions = {
        // Sprite UVs are top-down (origin at image top-left); do not flip.
        invertY: false,
        // Atlas frames typically tile cleanly; use clamp to avoid bleeding from neighbouring cells at edges.
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        // Sprites usually look best with bilinear filtering and no mip chain — sharp pixel art still works in nearest.
        mipMaps: false,
        minFilter: options.sampling === "nearest" ? "nearest" : "linear",
        magFilter: options.sampling === "nearest" ? "nearest" : "linear",
        // Premultiply at decode if requested. Pair with `premultipliedAlpha: true` for
        // a mathematically honest premultiplied pipeline.
        premultiplyAlpha: options.premultiplyOnLoad ?? false,
        ...options.textureOptions,
    };

    const texture = await loadTexture2D(engine, textureUrl, texOpts);
    return createGridSpriteAtlas(texture, {
        cellWidthPx: options.gridSize[0],
        cellHeightPx: options.gridSize[1],
        // Default `false` — matches the straight RGBA bits the PNG decoder produces.
        // Callers wanting premultiplied blending should pass `premultiplyOnLoad: true`
        // *and* `premultipliedAlpha: true` together so storage and blend factors agree.
        premultipliedAlpha: options.premultipliedAlpha ?? false,
    });
}

/** @internal Resolve a frame index (just bounds-checks). Throws if out of range. */
export function resolveSpriteFrame(atlas: SpriteAtlas, frame: number): number {
    if (frame < 0 || frame >= atlas.frames.length) {
        throw new Error(`resolveSpriteFrame: index ${frame} out of range [0, ${atlas.frames.length})`);
    }
    return frame;
}
