/**
 * Lazy, null-by-default registry hooks for the sprite-family custom-shader feature.
 *
 * The always-loaded sprite/billboard factory, pipeline, and renderer/renderable modules must
 * stay free of every custom-shader-specific symbol AND of the public `customShader` /
 * `shaderParams` field-name strings (both ship bytes into plain scenes). They reach the feature
 * exclusively through these hooks, which are `null` until a caller builds a custom shader —
 * `createSprite2DCustomShader` / `createBillboardCustomShader` register the impl. A plain scene
 * never imports the impl module, so the hook stays `null` and the always-loaded callers carry
 * zero custom-shader bytes — mirroring the PBR extension registry (`pbr-flags.ts`).
 *
 * The hook methods take the layer / system **opaquely** and perform all `customShader` /
 * `shaderParams` property access INSIDE the (tree-shaken) impl, so even the public field-name
 * strings stay out of the always-loaded path. No module-level side effects: the two hook slots
 * are plain nullable `let`s, registration is explicit.
 */
import type { EngineContext } from "../engine/engine.js";
import type { Sprite2DLayer, Sprite2DLayerOptions } from "./sprite-2d.js";
import type { BillboardSpriteSystem, BillboardSpriteSystemOptions } from "./billboard-sprite.js";
import type { SpriteLayerFx } from "./custom-shader-core.js";

/** @internal Generic 2D-sprite custom-shader hook. The impl reads `layer.customShader` / `layer.shaderParams`. */
export interface SpriteFxHook {
    /** Copy `opts.customShader` (+ a zeroed `shaderParams`) onto a freshly built layer, if present. */
    initLayer(layer: Sprite2DLayer, opts: Sprite2DLayerOptions): void;
    /** Extra pipeline-cache key part for `layer` (`""` when it has no custom shader). */
    pipelineKeyPart(layer: Sprite2DLayer): string;
    /** Custom shader module for `layer`, or `null` to fall back to the default sprite shader. */
    shaderModule(engine: EngineContext, hasDepth: boolean, layer: Sprite2DLayer): GPUShaderModule | null;
    /** Extra bind-group-layout entries for `layer`, or `null` when it has no custom shader. */
    layoutEntries(layer: Sprite2DLayer, startBinding: number): GPUBindGroupLayoutEntry[] | null;
    /** Build the opaque fx attachment for `layer`, or `null` when it has no custom shader. */
    createLayerFx(engine: EngineContext, label: string, layer: Sprite2DLayer): SpriteLayerFx | null;
    /** Per-frame fx update (reads `layer.shaderParams`). */
    updateFx(fx: SpriteLayerFx, layer: Sprite2DLayer, deltaMs: number): void;
    /** Append the fx bind-group entries, starting at `startBinding` (always 3). */
    bindEntries(fx: SpriteLayerFx, startBinding: number): GPUBindGroupEntry[];
    /** Destroy the fx attachment. */
    disposeFx(fx: SpriteLayerFx): void;
}

/** @internal Generic billboard custom-shader hook. The impl reads `system._customShader` / `system.shaderParams`. */
export interface BillboardFxHook {
    /** Copy `opts.customShader` (+ a zeroed `shaderParams`) onto a freshly built system, if present. */
    initSystem(system: BillboardSpriteSystem, opts: BillboardSpriteSystemOptions): void;
    /** Extra pipeline-cache key part for `system` (`""` when it has no custom shader). */
    pipelineKeyPart(system: BillboardSpriteSystem): string;
    /** Custom shader module for `system`, or `null` to fall back to the default billboard shader. */
    shaderModule(engine: EngineContext, system: BillboardSpriteSystem): GPUShaderModule | null;
    /** Extra bind-group-layout entries for `system`, or `null` when it has no custom shader. */
    layoutEntries(system: BillboardSpriteSystem, startBinding: number): GPUBindGroupLayoutEntry[] | null;
    /** Build the opaque fx attachment for `system`, or `null` when it has no custom shader. */
    createLayerFx(engine: EngineContext, label: string, system: BillboardSpriteSystem): SpriteLayerFx | null;
    /** Per-frame fx update (reads `system.shaderParams`). */
    updateFx(fx: SpriteLayerFx, system: BillboardSpriteSystem, deltaMs: number): void;
    /** Append the fx bind-group entries, starting at `startBinding` (always 3). */
    bindEntries(fx: SpriteLayerFx, startBinding: number): GPUBindGroupEntry[];
    /** Destroy the fx attachment. */
    disposeFx(fx: SpriteLayerFx): void;
}

let _spriteFxHook: SpriteFxHook | null = null;
let _billboardFxHook: BillboardFxHook | null = null;

/** @internal Register the 2D-sprite custom-shader hook. Idempotent; called by `createSprite2DCustomShader`. */
export function _registerSpriteFxHook(hook: SpriteFxHook): void {
    _spriteFxHook = hook;
}
/** @internal The registered 2D-sprite custom-shader hook, or `null` when no custom shader exists. */
export function _getSpriteFxHook(): SpriteFxHook | null {
    return _spriteFxHook;
}
/** @internal Register the billboard custom-shader hook. Idempotent; called by `createBillboardCustomShader`. */
export function _registerBillboardFxHook(hook: BillboardFxHook): void {
    _billboardFxHook = hook;
}
/** @internal The registered billboard custom-shader hook, or `null` when no custom shader exists. */
export function _getBillboardFxHook(): BillboardFxHook | null {
    return _billboardFxHook;
}
