/**
 * Opt-in coverage-gamma feature for `Sprite2DLayer` (glyph-atlas "stem darkening").
 *
 * Importing `setSprite2DCoverageGamma` is the trigger that pulls this module — and with it the
 * gamma fragment permutation, the `aa.x` UBO writer, and the pipeline-key part — into the bundle.
 * Sprite scenes that never call the setter keep the coverage-gamma hook `null`, so the
 * always-loaded sprite pipeline (`sprite-pipeline.ts`) carries zero gamma bytes.
 *
 * The hook methods take the layer **opaquely**; all `_coverageGamma` property access happens here,
 * in the tree-shaken module, so even the field-name string stays out of the always-loaded path —
 * mirroring the custom-shader hook (`sprite-fx-hook.ts`).
 */
import type { EngineContext } from "../engine/engine.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import { makeSpritePrologueWgsl } from "./sprite-pipeline.js";
import type { SpriteCoverageGammaHook } from "./sprite-coverage-gamma-hook.js";
import { _registerSpriteCoverageGammaHook } from "./sprite-coverage-gamma-hook.js";

/**
 * Coverage-gamma sprite shader: the base prologue (vertex stage + `Layer` UBO with its `aa`
 * slot) plus a fragment that raises sampled alpha to `1/coverageGamma` (`L.aa.x`) so anti-aliased
 * glyph edges composite heavier, mimicking gamma-space stem darkening.
 */
function makeCoverageGammaWgsl(hasDepth: boolean, spriteGroupIndex: 0 | 1, uvScroll: boolean): string {
    return `${makeSpritePrologueWgsl(hasDepth, spriteGroupIndex, uvScroll)}
@fragment
fn fs(in: O) -> @location(0) vec4f {
let s = textureSample(atlasTex, atlasSamp, in.uv);
let a = pow(s.a, L.aa.x);
return vec4f(s.rgb, a) * in.tint * L.opacityMul;
}`;
}

let _shaderCache: WeakMap<GPUDevice, Map<string, GPUShaderModule>> | null = null;

function getCoverageGammaShaderModule(engine: EngineContext, hasDepth: boolean, uvScroll: boolean): GPUShaderModule {
    const device = engine._device;
    const cache = (_shaderCache ??= new WeakMap());
    let perDevice = cache.get(device);
    if (!perDevice) {
        perDevice = new Map();
        cache.set(device, perDevice);
    }
    const key = `${hasDepth ? 1 : 0}:${uvScroll ? 1 : 0}`;
    let module = perDevice.get(key);
    if (!module) {
        module = device.createShaderModule({ code: makeCoverageGammaWgsl(hasDepth, hasDepth ? 1 : 0, uvScroll) });
        perDevice.set(key, module);
    }
    return module;
}

/**
 * True when `layer` has an active coverage gamma set via the opt-in setter. Active requires a
 * **finite, positive, non-identity** value: `1` is the identity no-op, and `0` / negative / `NaN` /
 * `Infinity` are rejected so `writeUbo` never produces a non-finite `1/gamma` exponent for `pow`.
 */
function isGammaActive(layer: Sprite2DLayer): boolean {
    const g = layer._coverageGamma;
    return g != null && Number.isFinite(g) && g > 0 && g !== 1;
}

const COVERAGE_GAMMA_HOOK: SpriteCoverageGammaHook = {
    pipelineKeyPart(layer: Sprite2DLayer): string {
        return isGammaActive(layer) ? "1" : "0";
    },
    shaderModule(engine: EngineContext, hasDepth: boolean, layer: Sprite2DLayer): GPUShaderModule | null {
        if (!isGammaActive(layer)) {
            return null;
        }
        return getCoverageGammaShaderModule(engine, hasDepth, layer._uvScrollAttr != null);
    },
    writeUbo(layer: Sprite2DLayer, ubo: Float32Array): void {
        // aa.x = 1/coverageGamma for active gamma layers; 0 otherwise (the base shader ignores aa,
        // but the reused scratch UBO must stay deterministic across mixed gamma / non-gamma layers).
        if (isGammaActive(layer)) {
            ubo[12] = 1 / layer._coverageGamma!;
        } else {
            ubo[12] = 0;
        }
    },
};

/**
 * Enable (or update) coverage gamma on a sprite layer for anti-aliased glyph "stem darkening".
 *
 * Coverage gamma raises the layer's sampled texture alpha to `1/coverageGamma` in the fragment
 * shader, thickening anti-aliased edges to mimic the gamma-space blending of native text
 * rasterizers (DirectWrite/CoreText). Intended for glyph-atlas (bitmap text) layers drawn into an
 * sRGB (linear-blended) surface, where correct linear AA otherwise makes text look lighter/thinner.
 * Values `> 1` thicken; `1` is a no-op (identity) and disables the effect. Non-finite or non-positive
 * values (`0`, negatives, `NaN`, `Infinity`) are also treated as disabled (the base shader is used).
 *
 * **Opt-in & tree-shakable:** importing this function is what pulls the coverage-gamma shader
 * permutation and UBO writer into the bundle. Sprite scenes that never call it ship zero gamma
 * bytes. The gamma value is stored internally on the layer and is *only* settable through this
 * function — there is no create-time option and no public field, so a value can never be written
 * that the renderer would silently ignore. Call it before `createSpriteRenderer` /
 * `addDepthHostedSpriteLayer` so the layer's first pipeline is built with the gamma permutation;
 * calling it later is also safe — the renderer re-fetches the pipeline each frame and rebuilds it
 * with the gamma permutation on the next frame.
 *
 * @param layer - The sprite layer to configure.
 * @param gamma - Coverage gamma. Typical text values are ~1.8–2.2; `1` disables the effect.
 */
export function setSprite2DCoverageGamma(layer: Sprite2DLayer, gamma: number): void {
    _registerSpriteCoverageGammaHook(COVERAGE_GAMMA_HOOK);
    (layer as { _coverageGamma?: number })._coverageGamma = gamma;
}
