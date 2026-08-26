import { clearEngine, type GLEngineContext, type GLTexture } from "babylon-lite-gl";
import { createSpriteRenderer, disposeSpriteRenderer, renderSprites, setSpriteRendererTexture, type GLSprite, type GLSpriteRenderer } from "babylon-lite-gl/sprites";

import { type Matrix } from "../maths/matrix";

import { type LottieRendererConfig } from "../animationConfiguration";

/** Largest sprite count a single lite-gl sprite renderer can draw (Uint16 index-buffer limit). */
const MAX_SPRITE_CAPACITY = 16384;

/** A run of consecutive sprites that share the same atlas page, drawn in one pass. */
type SpriteBatch = { sprites: GLSprite[]; pageIndex: number };

/**
 * Holds all the sprites from the animation and the state needed to render them. Supports multiple
 * atlas pages — when sprites span more than one texture, {@link renderFrame} performs one pass per
 * page, switching the sprite renderer texture between passes. This is plain state operated on by the
 * functions below — there is no instance behavior.
 */
export type RenderingManager = {
    /** lite-gl engine context used for rendering. */
    engine: GLEngineContext;
    /** Sprite renderer, created lazily in {@link prepareRenderingManager} once the atlas exists. */
    spritesRenderer: GLSpriteRenderer | null;
    /** Final atlas page textures, captured after all sprites have been packed. */
    spritesTextures: GLTexture[];
    /** All sprites to draw, sorted back-to-front after preparation. */
    sprites: GLSprite[];
    /** Original Lottie layer index per sprite, used to sort; cleared after preparation. */
    spriteLayerIndices: number[];
    /** Atlas page index per sprite. */
    spriteAtlasIndices: number[];
    /** Pre-computed render batches so {@link renderFrame} does not allocate per frame. */
    batches: SpriteBatch[];
    /** Renderer-bound configuration. */
    configuration: LottieRendererConfig;
};

/**
 * Creates a new rendering manager. The sprite renderer itself is created lazily in
 * {@link prepareRenderingManager} once the packed atlas pages and the final sprite count are known.
 * @param engine lite-gl engine context used for rendering.
 * @param configuration Configuration options for the rendering manager.
 * @returns The new rendering manager state.
 */
export function createRenderingManager(engine: GLEngineContext, configuration: LottieRendererConfig): RenderingManager {
    return {
        engine,
        spritesRenderer: null,
        spritesTextures: [],
        sprites: [],
        spriteLayerIndices: [],
        spriteAtlasIndices: [],
        batches: [],
        configuration,
    };
}

/**
 * Adds a sprite to the rendering manager.
 * @param manager The rendering manager.
 * @param sprite Sprite to add to the rendering manager.
 * @param layerIndex The original layer index from the Lottie file, used to determine rendering order.
 * @param atlasIndex The atlas page index this sprite belongs to.
 */
export function addSprite(manager: RenderingManager, sprite: GLSprite, layerIndex: number, atlasIndex: number): void {
    manager.sprites.push(sprite);
    manager.spriteLayerIndices.push(layerIndex);
    manager.spriteAtlasIndices.push(atlasIndex);
}

/**
 * Prepares the rendering manager for rendering.
 * Sorts sprites so they render back-to-front based on the original Lottie layer order.
 * In Lottie, layer 0 is the frontmost (rendered last), so higher indices render first (further back).
 * Within the same layer, later-added sprites render first (further back).
 *
 * Also auto-grows the SpriteRenderer capacity if needed and sets the atlas textures.
 * @param manager The rendering manager.
 * @param spriteTextures The final array of atlas page textures, captured after all sprites have been packed.
 */
export function prepareRenderingManager(manager: RenderingManager, spriteTextures: GLTexture[]): void {
    // Capture the final set of atlas textures now that all sprites have been packed
    manager.spritesTextures = spriteTextures;

    // Create the sprite renderer now that the atlas textures and the final sprite count are known.
    // Capacity is the larger of the configured capacity and the actual sprite count (clamped to the
    // Uint16 index limit), so every sprite is drawable in a single pass per atlas page. Mirrors the
    // old SpriteRenderer(engine, capacity, 0) setup: epsilon 0 (the lottie atlas relies on
    // edge-extruded cells + center sampling), alpha mode kept across multi-page passes
    // (autoResetAlpha false), and no depth pre-pass (pure 2D).
    const capacity = Math.min(Math.max(manager.configuration.spritesCapacity, manager.sprites.length, 1), MAX_SPRITE_CAPACITY);
    manager.spritesRenderer = createSpriteRenderer(manager.engine, {
        capacity,
        texture: manager.spritesTextures[0],
        epsilon: 0,
        autoResetAlpha: false,
        disableDepthWrite: true,
    });

    // Build index array and stable-sort by original layer index descending
    const count = manager.sprites.length;
    const indices = new Array<number>(count);
    for (let i = 0; i < count; i++) {
        indices[i] = i;
    }
    indices.sort((a, b) => {
        const layerDiff = manager.spriteLayerIndices[b] - manager.spriteLayerIndices[a];
        if (layerDiff !== 0) {
            return layerDiff;
        }
        // Within the same layer, later-added sprites are further back (rendered first)
        return b - a;
    });
    manager.sprites = indices.map((i) => manager.sprites[i]);
    manager.spriteAtlasIndices = indices.map((i) => manager.spriteAtlasIndices[i]);

    // Layer indices are no longer needed after sorting
    manager.spriteLayerIndices.length = 0;

    // Pre-compute render batches so renderFrame() doesn't allocate per frame
    manager.batches.length = 0;
    if (manager.sprites.length > 0 && manager.spritesTextures.length > 1) {
        let batchStart = 0;
        let currentPage = manager.spriteAtlasIndices[0];

        for (let i = 1; i <= manager.sprites.length; i++) {
            const page = i < manager.sprites.length ? manager.spriteAtlasIndices[i] : -1;
            if (page !== currentPage) {
                manager.batches.push({ sprites: manager.sprites.slice(batchStart, i), pageIndex: currentPage });
                batchStart = i;
                currentPage = page;
            }
        }
    }
}

/**
 * Renders all the sprites in the rendering manager.
 * When sprites span multiple atlas pages, renders in sorted z-order by batching
 * consecutive runs of sprites that share the same atlas page.
 * @param manager The rendering manager.
 * @param worldMatrix World matrix to apply to the sprites.
 * @param projectionMatrix Projection matrix to apply to the sprites.
 */
export function renderFrame(manager: RenderingManager, worldMatrix: Matrix, projectionMatrix: Matrix): void {
    clearEngine(manager.engine, { color: manager.configuration.backgroundColor });

    const renderer = manager.spritesRenderer;
    if (renderer === null) {
        return;
    }

    const view = worldMatrix;
    const projection = projectionMatrix;

    if (manager.batches.length === 0) {
        // Fast path: single atlas — render everything in one call
        renderSprites(renderer, manager.sprites, 0, view, projection);
    } else {
        // Multi-atlas: iterate pre-computed batches (no per-frame allocations)
        for (const batch of manager.batches) {
            setSpriteRendererTexture(renderer, manager.spritesTextures[batch.pageIndex]);
            renderSprites(renderer, batch.sprites, 0, view, projection);
        }
    }
}

/**
 * Disposes the rendering manager and its resources.
 * @param manager The rendering manager.
 */
export function disposeRenderingManager(manager: RenderingManager): void {
    manager.sprites.length = 0;
    // disposeSpriteRenderer releases the renderer's own GPU buffers + effect but NOT the atlas
    // textures (the SpritePacker owns those; the controller disposes them separately).
    if (manager.spritesRenderer !== null) {
        disposeSpriteRenderer(manager.spritesRenderer);
        manager.spritesRenderer = null;
    }
}
