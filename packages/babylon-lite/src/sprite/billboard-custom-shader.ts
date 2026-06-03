/**
 * Optional, tree-shakable custom-shader hook for `*BillboardSpriteSystem`.
 *
 * The default billboard pipeline bakes a fixed fragment (sample × tint, with an optional cutout
 * discard). Some scenes need a different per-fragment treatment — palette-indexed sampling,
 * COLORMAP light banding, toon shading, custom fog — and/or extra texture bindings beyond the
 * atlas. This module lets a caller supply a WGSL fragment body plus extra textures while the
 * billboard system keeps full ownership of geometry, instancing, sorting, and depth.
 *
 * Tree-shaking contract: the default billboard path never imports this module.
 * `billboard-pipeline.ts` only reaches the custom composer through the opaque object a caller
 * builds here via `createBillboardCustomShader`, so a scene that uses only stock billboards
 * pays zero bytes for this code.
 *
 * WGSL contract for the supplied `fragment` body:
 *   - Receives `in: VOut` with: `uv: vec2<f32>`, `tint: vec4<f32>` (the per-sprite `color`),
 *     `viewDist: f32` (distance from the camera to the sprite anchor in world units, constant
 *     across the quad), `vWorldPos: vec3<f32>` (this fragment's world position).
 *   - Has access to `atlasTex` / `atlasSamp` (the system atlas at group 1, bindings 1/2), each
 *     extra texture as `<name>Tex` / `<name>Samp`, the `fx` UBO (`fx.time`, `fx.params`), and
 *     the `billboards` system UBO (e.g. `billboards.opacityMul`).
 *   - Must `return vec4<f32>(...)` (and may `discard`). No automatic cutout is injected — the
 *     body owns all alpha handling.
 */
import { SCENE_UBO_WGSL } from "../shader/scene-uniforms.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { BillboardDepthMode, BillboardOrientation } from "./billboard-sprite.js";
import { makeBillboardBasisWgsl } from "./billboard-pipeline.js";
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
import type { BillboardFxHook } from "./sprite-fx-hook.js";
import { _registerBillboardFxHook } from "./sprite-fx-hook.js";

/** One extra texture bound after the atlas (group 1, bindings 3, 5, 7, …). */
export type BillboardCustomTexture = CustomShaderTexture;

/** Options for {@link createBillboardCustomShader}. */
export interface BillboardCustomShaderOptions {
    /** WGSL fragment body. See the module docs for the in-scope identifiers. */
    readonly fragment: string;
    /** Extra textures, in binding order. Each contributes a `texture_2d` + `sampler`. */
    readonly extraTextures?: readonly BillboardCustomTexture[];
}

/** Opaque custom-shader descriptor produced by {@link createBillboardCustomShader}. */
export interface BillboardCustomShader {
    readonly _entityType: "billboard-custom-shader";
    /** @internal Extra textures bound after the atlas. */
    readonly _extraTextures: readonly BillboardCustomTexture[];
    /** @internal Pipeline/shader-module cache discriminator. */
    readonly _key: string;
    /** @internal Builds the full WGSL for the given orientation (depth mode is irrelevant — the body owns alpha). */
    readonly _composeWgsl: (orientation: BillboardOrientation, depthMode: BillboardDepthMode) => string;
    /** @internal Compile + cache the `GPUShaderModule` for an orientation (owns its per-device cache). */
    readonly _getShaderModule: (engine: EngineContextInternal, orientation: BillboardOrientation, depthMode: BillboardDepthMode) => GPUShaderModule;
    /** @internal Extra-texture + fx UBO bind-group **layout** entries, starting at `startBinding` (3). */
    readonly _layoutEntries: (startBinding: number) => GPUBindGroupLayoutEntry[];
    /** @internal Build the opaque per-system fx attachment (owns the `SpriteFx` UBO, scratch, and elapsed time). */
    readonly _createLayerFx: (engine: EngineContextInternal, label: string) => SpriteLayerFx;
}

function makeCustomBillboardWgsl(orientation: BillboardOrientation, extraTextures: readonly BillboardCustomTexture[], fragment: string): string {
    const fxBinding = 3 + extraTextures.length * 2;
    return `${SCENE_UBO_WGSL}
struct BillboardSystem {
opacityMul: vec4<f32>,
axisAndCutoff: vec4<f32>,
};
@group(1) @binding(0) var<uniform> billboards: BillboardSystem;
@group(1) @binding(1) var atlasTex: texture_2d<f32>;
@group(1) @binding(2) var atlasSamp: sampler;
${makeExtraBindingsWgsl(1, 3, extraTextures)}${makeFxStructWgsl(1, fxBinding)}
${makeBillboardBasisWgsl(orientation)}
struct VIn {
@builtin(vertex_index) vid: u32,
@location(0) iPos: vec3<f32>,
@location(1) iSize: vec2<f32>,
@location(2) iUvMin: vec2<f32>,
@location(3) iUvMax: vec2<f32>,
@location(4) iRot: f32,
@location(5) iPivot: vec2<f32>,
@location(6) iColor: vec4<f32>,
};
struct VOut {
@builtin(position) pos: vec4<f32>,
@location(0) uv: vec2<f32>,
@location(1) tint: vec4<f32>,
@location(2) viewDist: f32,
@location(3) vWorldPos: vec3<f32>,
};
@vertex
fn vs(in: VIn) -> VOut {
let corner = vec2<f32>(select(0.0, 1.0, in.vid == 1u || in.vid == 2u), select(0.0, 1.0, in.vid >= 2u));
let local = (corner - in.iPivot) * in.iSize;
let cosRot = cos(in.iRot);
let sinRot = sin(in.iRot);
let rotated = vec2<f32>(local.x * cosRot - local.y * sinRot, local.x * sinRot + local.y * cosRot);
let basis = getBillboardBasis(in.iPos);
let worldPos = in.iPos + basis.right * rotated.x + basis.up * rotated.y;
var out: VOut;
out.pos = scene.viewProjection * vec4<f32>(worldPos, 1.0);
out.uv = mix(in.iUvMin, in.iUvMax, corner);
out.tint = in.iColor;
let viewCenter = scene.view * vec4<f32>(in.iPos, 1.0);
out.viewDist = length(viewCenter.xyz);
out.vWorldPos = worldPos;
return out;
}
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
${fragment}
}`;
}

/**
 * The billboard custom-shader hook implementation. Lives only in this (tree-shaken) module, so the
 * always-loaded billboard path never names `_customShader` / `shaderParams`. Reads both off the
 * opaque `system` and delegates to the descriptor's underscore-prefixed (mangled) methods.
 */
const BILLBOARD_FX_HOOK: BillboardFxHook = {
    initSystem(system, opts) {
        const customShader = opts.customShader;
        if (customShader) {
            (system as { _customShader?: BillboardCustomShader })._customShader = customShader;
            system.shaderParams = [0, 0, 0, 0];
        }
    },
    pipelineKeyPart(system) {
        return system._customShader?._key ?? "";
    },
    shaderModule(engine, system) {
        return system._customShader?._getShaderModule(engine, system._orientation, system._depthMode) ?? null;
    },
    layoutEntries(system, startBinding) {
        return system._customShader?._layoutEntries(startBinding) ?? null;
    },
    createLayerFx(engine, label, system) {
        return system._customShader?._createLayerFx(engine, label) ?? null;
    },
    updateFx(fx, system, deltaMs) {
        fx.update(system.shaderParams ?? EMPTY_PARAMS, deltaMs);
    },
    bindEntries(fx, startBinding) {
        return fx.bindEntries(startBinding);
    },
    disposeFx(fx) {
        fx.destroy();
    },
};

/**
 * Build a custom-shader descriptor to pass as `customShader` when creating a billboard system.
 * The descriptor is opaque; the pipeline consumes it lazily.
 */
export function createBillboardCustomShader(options: BillboardCustomShaderOptions): BillboardCustomShader {
    _registerBillboardFxHook(BILLBOARD_FX_HOOK);
    const fragment = options.fragment;
    if (typeof fragment !== "string" || fragment.trim().length === 0) {
        throw new Error("createBillboardCustomShader: `fragment` must be a non-empty WGSL string.");
    }
    const extraTextures = options.extraTextures ?? [];
    validateExtraTextureNames("createBillboardCustomShader", extraTextures);
    const moduleCache = makeShaderModuleCache();
    return {
        _entityType: "billboard-custom-shader",
        _extraTextures: extraTextures,
        _key: nextCustomShaderKey("c"),
        _composeWgsl: (orientation) => makeCustomBillboardWgsl(orientation, extraTextures, fragment),
        _getShaderModule: (engine, orientation, depthMode) =>
            moduleCache(engine, `${orientation}:${depthMode}`, () => makeCustomBillboardWgsl(orientation, extraTextures, fragment)),
        _layoutEntries: (startBinding) => makeCustomShaderLayoutEntries(extraTextures, startBinding),
        _createLayerFx: (engine, label) => createSpriteLayerFx(engine, label, extraTextures),
    };
}
