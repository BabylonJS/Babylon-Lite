/**
 * Optional, tree-shakable custom-shader hook for `Sprite2DLayer` (the engine owns the layer
 * transform, instancing, sorting, and depth; the caller supplies only a WGSL **fragment body**
 * plus optional extra textures).
 *
 * Works on both pure-2D HUD layers (`depth: "none"`, drawn by a `SpriteRenderer`) and
 * depth-hosted 2.5D layers (`depth: "test"` / `"test-write"`, drawn as scene `Renderable`s).
 * The 2D and billboard composers share their *mechanics* via `custom-shader-core.ts`
 * (extra-texture bindings, name validation, the `SpriteFx` UBO, key allocation) but keep their
 * own vertex stage and varying contract, which genuinely differ: billboards transform in world
 * space and expose `viewDist`/`worldPos`; a 2D layer transforms in pixel space and exposes only
 * `uv`/`tint`.
 *
 * Tree-shaking contract: the default sprite path never imports this module. `sprite-pipeline.ts`
 * only reaches the custom composer through the opaque object a caller builds here via
 * `createSprite2DCustomShader`, so a layer that uses the stock shader pays zero bytes for it.
 *
 * WGSL contract for the supplied `fragment` body:
 *   - Receives `in: VOut` with `uv: vec2<f32>` and `tint: vec4<f32>` (the per-sprite `color`).
 *   - Has access to `atlasTex` / `atlasSamp` (the layer atlas at bindings 1/2), each extra
 *     texture as `<name>Tex` / `<name>Samp`, the `fx` UBO (`fx.time`, `fx.params`), and the
 *     `L` layer UBO (e.g. `L.opacityMul`).
 *   - Must `return vec4<f32>(...)` (and may `discard`). The body owns all alpha handling; no
 *     per-layer opacity is applied automatically.
 */
import type { CustomShaderTexture, SpriteLayerFx } from "./custom-shader-core.js";
import {
    createSpriteLayerFx,
    EMPTY_PARAMS,
    makeCustomShaderLayoutEntries,
    makeExtraBindingsWgsl,
    makeFxStructWgsl,
    makeShaderModuleCache,
    nextCustomShaderKey,
    validateExtraTextureNames,
} from "./custom-shader-core.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { makeSpritePrologueWgsl } from "./sprite-pipeline.js";
import type { SpriteFxHook } from "./sprite-fx-hook.js";
import { _registerSpriteFxHook } from "./sprite-fx-hook.js";

/** One extra texture bound after the atlas. In WGSL it becomes `<name>Tex` + `<name>Samp`. */
export type Sprite2DCustomTexture = CustomShaderTexture;

/** Options for {@link createSprite2DCustomShader}. */
export interface Sprite2DCustomShaderOptions {
    /** WGSL fragment body. See the module docs for the in-scope identifiers. */
    readonly fragment: string;
    /** Extra textures, in binding order. Each contributes a `texture_2d` + `sampler`. */
    readonly extraTextures?: readonly Sprite2DCustomTexture[];
}

/** A compiled-on-demand custom sprite shader. Pure data; pass as `customShader` to `createSprite2DLayer`. */
export interface Sprite2DCustomShader {
    readonly _entityType: "sprite-2d-custom-shader";
    /** @internal Extra textures bound after the atlas. */
    readonly _extraTextures: readonly Sprite2DCustomTexture[];
    /** @internal Stable identity used to key pipeline + shader-module caches. */
    readonly _key: string;
    /** @internal Compose the full WGSL module for a given layout (`hasDepth` → group index). */
    readonly _composeWgsl: (hasDepth: boolean, spriteGroupIndex: 0 | 1, uvScroll: boolean) => string;
    /** @internal Compile + cache the `GPUShaderModule` for a layout (owns its per-device cache). */
    readonly _getShaderModule: (engine: EngineContextInternal, hasDepth: boolean, uvScroll: boolean) => GPUShaderModule;
    /** @internal Extra-texture + fx UBO bind-group **layout** entries, starting at `startBinding` (3). */
    readonly _layoutEntries: (startBinding: number) => GPUBindGroupLayoutEntry[];
    /** @internal Build the opaque per-layer fx attachment (owns the `SpriteFx` UBO, scratch, and elapsed time). */
    readonly _createLayerFx: (engine: EngineContextInternal, label: string) => SpriteLayerFx;
}

function makeCustomSpriteWgsl(hasDepth: boolean, spriteGroupIndex: 0 | 1, extraTextures: readonly Sprite2DCustomTexture[], fragment: string, uvScroll: boolean): string {
    const fxBinding = 3 + extraTextures.length * 2;
    return `${makeSpritePrologueWgsl(hasDepth, spriteGroupIndex, uvScroll)}
${makeExtraBindingsWgsl(spriteGroupIndex, 3, extraTextures)}${makeFxStructWgsl(spriteGroupIndex, fxBinding)}
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
${fragment}
}`;
}

/**
 * The 2D-sprite custom-shader hook implementation. Lives only in this (tree-shaken) module, so the
 * always-loaded sprite path never names `customShader` / `shaderParams`. Reads both off the opaque
 * `layer` and delegates to the descriptor's underscore-prefixed (mangled) methods.
 */
const SPRITE_FX_HOOK: SpriteFxHook = {
    initLayer(layer, opts) {
        const customShader = opts.customShader;
        if (customShader) {
            (layer as { customShader?: Sprite2DCustomShader }).customShader = customShader;
            layer.shaderParams = [0, 0, 0, 0];
        }
    },
    pipelineKeyPart(layer) {
        return layer.customShader?._key ?? "";
    },
    shaderModule(engine, hasDepth, layer) {
        return layer.customShader?._getShaderModule(engine, hasDepth, layer._uvScroll === true) ?? null;
    },
    layoutEntries(layer, startBinding) {
        return layer.customShader?._layoutEntries(startBinding) ?? null;
    },
    createLayerFx(engine, label, layer) {
        return layer.customShader?._createLayerFx(engine, label) ?? null;
    },
    updateFx(fx, layer, deltaMs) {
        fx.update(layer.shaderParams ?? EMPTY_PARAMS, deltaMs);
    },
    bindEntries(fx, startBinding) {
        return fx.bindEntries(startBinding);
    },
    disposeFx(fx) {
        fx.destroy();
    },
};

/**
 * Create a custom fragment shader for a sprite layer. Pass the result as the `customShader`
 * option of `createSprite2DLayer`. See the module-level docs for the WGSL contract.
 */
export function createSprite2DCustomShader(options: Sprite2DCustomShaderOptions): Sprite2DCustomShader {
    _registerSpriteFxHook(SPRITE_FX_HOOK);
    const fragment = options.fragment;
    if (typeof fragment !== "string" || fragment.trim().length === 0) {
        throw new Error("createSprite2DCustomShader: `fragment` must be a non-empty WGSL string.");
    }
    const extraTextures = options.extraTextures ?? [];
    validateExtraTextureNames("createSprite2DCustomShader", extraTextures);
    const moduleCache = makeShaderModuleCache();
    return {
        _entityType: "sprite-2d-custom-shader",
        _extraTextures: extraTextures,
        _key: nextCustomShaderKey("s"),
        _composeWgsl: (hasDepth, spriteGroupIndex, uvScroll) => makeCustomSpriteWgsl(hasDepth, spriteGroupIndex, extraTextures, fragment, uvScroll),
        // `spriteGroupIndex = hasDepth ? 1 : 0`: depth-hosted layers put the scene UBO at group 0, so the
        // sprite resources (atlas, extras, fx) shift to group 1; pure-2D layers keep them at group 0.
        _getShaderModule: (engine, hasDepth, uvScroll) =>
            moduleCache(engine, `${hasDepth ? "1" : "0"}:${uvScroll ? "u" : "-"}`, () => makeCustomSpriteWgsl(hasDepth, hasDepth ? 1 : 0, extraTextures, fragment, uvScroll)),
        _layoutEntries: (startBinding) => makeCustomShaderLayoutEntries(extraTextures, startBinding),
        _createLayerFx: (engine, label) => createSpriteLayerFx(engine, label, extraTextures),
    };
}
