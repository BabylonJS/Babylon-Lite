import { type AnimationNode } from "../nodes/node";

/**
 * Renderer-agnostic description of a sprite produced while parsing a Lottie animation.
 * Parsing and feature modules emit these plain records instead of constructing renderer
 * objects directly. A renderer adapter (e.g. the Babylon sprite adapter) materializes them
 * into concrete sprites and registers them for rendering. This keeps parsing and features
 * free of any specific rendering backend.
 */
export type LottieSpriteRecord = {
    /**
     * Scene-graph node that drives this sprite's per-frame transform and opacity.
     * The renderer adapter attaches the concrete sprite to this node.
     */
    node: AnimationNode;
    /** Index of the atlas page this sprite belongs to. */
    atlasIndex: number;
    /** Normalized horizontal offset of the sprite in the atlas page, left to right. */
    uOffset: number;
    /** Normalized vertical offset of the sprite in the atlas page, top to bottom. */
    vOffset: number;
    /** Horizontal atlas cell size in pixels. Zero for point-sampled sprites such as solids. */
    uSize: number;
    /** Vertical atlas cell size in pixels. Zero for point-sampled sprites such as solids. */
    vSize: number;
    /** Sprite width on screen in pixels, before per-frame scaling. */
    width: number;
    /** Sprite height on screen in pixels, before per-frame scaling. */
    height: number;
    /** Whether the sprite samples its atlas region with an inverted V coordinate. */
    invertV: boolean;
    /** Original Lottie layer index used to determine back-to-front render order. */
    layerOrder: number;
};
