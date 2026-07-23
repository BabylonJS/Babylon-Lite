/**
 * Shared mechanics for the sprite-family custom-shader hooks (the engine owns the pipeline,
 * instancing, sorting, and vertex stage; the caller supplies only a WGSL **fragment body**
 * plus optional extra textures).
 *
 * This module holds **only** the parts that are identical across every sprite-family
 * custom-shader: extra-texture binding emission, WGSL-name validation, the always-present
 * `SpriteFx` UBO declaration, and cache-key allocation. Each system keeps its own composer
 * that owns its fixed vertex stage and varying contract — those genuinely differ (world-space
 * billboard facing vs. pixel-space 2D layer transform) and are not shared.
 *
 * Tree-shaking: a scene that never builds a custom shader never imports this module, so it
 * pays zero bytes for any of it. The GPU plumbing the custom-shader feature needs — the
 * `SpriteFx` UBO writer, the extra-texture / fx bind-group **layout** and **bind** entry
 * builders, and the per-device shader-module cache — also lives here (and is reached only
 * through a descriptor), so the always-loaded sprite/billboard pipeline + renderable modules
 * stay free of it.
 */
import { F32 } from "../engine/typed-arrays.js";
import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import type { Texture2D } from "../texture/texture-2d.js";

/** One extra texture bound after the atlas. In WGSL it becomes `<name>Tex` + `<name>Samp`. */
export interface CustomShaderTexture {
    /** Identifier used in WGSL: becomes `<name>Tex` (texture) and `<name>Samp` (sampler). */
    readonly name: string;
    readonly texture: Texture2D;
}

/**
 * Opaque, per-layer / per-system **fx attachment**. Every piece of custom-shader runtime
 * state — the `SpriteFx` UBO buffer, its CPU scratch, and the accumulated elapsed time — lives
 * INSIDE this object, which is created (via a descriptor's `_createLayerFx` hook) only when a
 * layer/system actually has a custom shader.
 *
 * The always-loaded sprite/billboard renderer + renderable modules store a single nullable
 * `SpriteLayerFx | null` and reach the entire fx lifecycle (bind, per-frame update, dispose)
 * through it. A plain layer (no custom shader) allocates no fx fields, runs no fx branch, and
 * accumulates no time — the descriptor module that builds this object is never imported, so the
 * plain path pays zero bytes for the feature.
 */
export interface SpriteLayerFx {
    /** Append the extra-texture + fx UBO bind-group entries, starting at `startBinding` (always 3). */
    bindEntries(startBinding: number): GPUBindGroupEntry[];
    /** Accumulate `deltaMs` internally, then write the `SpriteFx` UBO (time + `params`). */
    update(params: readonly number[], deltaMs: number): void;
    /** Destroy the `SpriteFx` UBO buffer. */
    destroy(): void;
}

/** Valid WGSL identifier (used to validate extra-texture names before splicing them in). */
const WGSL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shared all-zero `fx.params` fallback used when a layer/system has a custom shader but no params set. */
export const EMPTY_PARAMS: readonly number[] = [0, 0, 0, 0];

/** Throw if any extra-texture name is not a legal WGSL identifier. `fnName` names the caller for the message. */
export function validateExtraTextureNames(fnName: string, extras: readonly CustomShaderTexture[]): void {
    for (const extra of extras) {
        if (!WGSL_NAME.test(extra.name)) {
            throw new Error(`${fnName}: extra texture name "${extra.name}" is not a valid WGSL identifier.`);
        }
    }
}

/**
 * Emit the `@group(group) @binding(n) var <name>Tex/<name>Samp` pairs for the extra textures,
 * starting at `startBinding` and stepping by 2 (texture, then sampler). The atlas occupies
 * bindings 1/2, so callers pass `startBinding = 3`.
 */
export function makeExtraBindingsWgsl(group: number, startBinding: number, extras: readonly CustomShaderTexture[]): string {
    let out = "";
    for (let i = 0; i < extras.length; i++) {
        const binding = startBinding + i * 2;
        const name = extras[i]!.name;
        out += `@group(${group}) @binding(${binding}) var ${name}Tex: texture_2d<f32>;\n@group(${group}) @binding(${binding + 1}) var ${name}Samp: sampler;\n`;
    }
    return out;
}

/**
 * Emit the always-present `SpriteFx` UBO declaration. The struct layout (32 bytes) matches the
 * CPU writer {@link writeSpriteFxUbo}:
 *   [0]    time (seconds since the renderable's first frame)
 *   [1..3] padding (vec4 alignment)
 *   [4..7] params.xyzw (user-set via `setSprite2DShaderParams` / `setBillboardShaderParams`)
 * `binding` is `3 + 2 * extraTextures.length` so the UBO always lands after the extra textures.
 */
export function makeFxStructWgsl(group: number, binding: number): string {
    return `struct SpriteFx {
time: f32,
_p0: f32,
_p1: f32,
_p2: f32,
params: vec4f,
};
@group(${group}) @binding(${binding}) var<uniform> fx: SpriteFx;`;
}

let _nextKey = 0;

/** Allocate a process-unique pipeline/shader-module cache key with the given prefix. */
export function nextCustomShaderKey(prefix: string): string {
    return `${prefix}${_nextKey++}`;
}

/**
 * Per-custom-shader `SpriteFx` UBO size in bytes. Bound at `@binding(3 + 2 * extraTextures.length)`.
 * Layout matches the WGSL `SpriteFx` struct emitted by {@link makeFxStructWgsl}:
 *   [0]    time (seconds since the renderable's first frame)
 *   [1..3] padding (vec4 alignment)
 *   [4..7] params.xyzw (user-set via `setSprite2DShaderParams` / `setBillboardShaderParams`)
 */
export const SPRITE_FX_UBO_BYTES = 32;
/** Number of floats in the `SpriteFx` UBO scratch array. */
export const SPRITE_FX_UBO_FLOATS = SPRITE_FX_UBO_BYTES / 4;

/** Write the `SpriteFx` UBO (time + user params) for a custom-shader layer/system. */
export function writeSpriteFxUbo(device: GPUDevice, fxBuffer: GPUBuffer, timeSeconds: number, params: readonly number[], scratch: Float32Array): void {
    scratch[0] = timeSeconds;
    scratch[1] = 0;
    scratch[2] = 0;
    scratch[3] = 0;
    scratch[4] = params[0] ?? 0;
    scratch[5] = params[1] ?? 0;
    scratch[6] = params[2] ?? 0;
    scratch[7] = params[3] ?? 0;
    device.queue.writeBuffer(fxBuffer, 0, scratch.buffer, scratch.byteOffset, SPRITE_FX_UBO_BYTES);
}

/**
 * Build the extra-texture + `SpriteFx` bind-group **layout** entries for a custom shader,
 * starting at `startBinding` (always 3 — the atlas occupies 0/1/2). Each extra texture
 * contributes a `texture` + `sampler` entry (stepping by 2); the fx UBO lands last at
 * `startBinding + 2 * extras.length`. Returned to the always-loaded pipeline builder, which
 * only appends them — keeping the custom-shader loop out of the plain path.
 */
export function makeCustomShaderLayoutEntries(extras: readonly CustomShaderTexture[], startBinding: number): GPUBindGroupLayoutEntry[] {
    const entries: GPUBindGroupLayoutEntry[] = [];
    let binding = startBinding;
    for (let i = 0; i < extras.length; i++) {
        entries.push({ binding, visibility: SS.FRAGMENT, texture: { sampleType: "float" } });
        entries.push({ binding: binding + 1, visibility: SS.FRAGMENT, sampler: { type: "filtering" } });
        binding += 2;
    }
    entries.push({ binding, visibility: SS.FRAGMENT, buffer: { type: "uniform" } });
    return entries;
}

/**
 * Build the extra-texture + `SpriteFx` bind-group entries for a custom shader, mirroring the
 * layout produced by {@link makeCustomShaderLayoutEntries}. The fx UBO entry is emitted only
 * when `fxBuffer` is present.
 */
export function makeCustomShaderBindEntries(extras: readonly CustomShaderTexture[], startBinding: number, fxBuffer: GPUBuffer | null | undefined): GPUBindGroupEntry[] {
    const entries: GPUBindGroupEntry[] = [];
    let binding = startBinding;
    for (let i = 0; i < extras.length; i++) {
        const texture = extras[i]!.texture;
        entries.push({ binding, resource: texture.view });
        entries.push({ binding: binding + 1, resource: texture.sampler });
        binding += 2;
    }
    if (fxBuffer) {
        entries.push({ binding, resource: { buffer: fxBuffer } });
    }
    return entries;
}

/**
 * Build a per-layer / per-system fx attachment for a custom-shader descriptor. Allocates the
 * `SpriteFx` UBO + scratch, captures the descriptor's extra textures, and owns the elapsed-time
 * accumulator — all inside the returned closure. Exposed only through the descriptor's
 * `_createLayerFx` hook, so the always-loaded renderer/renderable modules never see the fx
 * machinery and the plain path pays nothing.
 */
export function createSpriteLayerFx(engine: EngineContext, label: string, extras: readonly CustomShaderTexture[]): SpriteLayerFx {
    const device = engine._device;
    const buffer = createEmptyUniformBuffer(engine, SPRITE_FX_UBO_BYTES, label);
    const scratch = new F32(SPRITE_FX_UBO_FLOATS);
    let elapsedMs = 0;
    return {
        bindEntries(startBinding) {
            return makeCustomShaderBindEntries(extras, startBinding, buffer);
        },
        update(params, deltaMs) {
            elapsedMs += deltaMs;
            writeSpriteFxUbo(device, buffer, elapsedMs / 1000, params, scratch);
        },
        destroy() {
            buffer.destroy();
        },
    };
}

/**
 * Build a per-device shader-module cache for a single custom-shader descriptor. The returned
 * function compiles + caches one `GPUShaderModule` per `(device, key)` pair, auto-invalidating
 * when the engine's device changes (a new `WeakMap` entry). Lives on the descriptor so the
 * always-loaded pipeline cache no longer needs a custom-module `Map`.
 */
export function makeShaderModuleCache(): (engine: EngineContext, key: string, makeCode: () => string) => GPUShaderModule {
    let devices: WeakMap<GPUDevice, Map<string, GPUShaderModule>> | null = null;
    return (engine, key, makeCode) => {
        devices ??= new WeakMap();
        let byKey = devices.get(engine._device);
        if (!byKey) {
            byKey = new Map();
            devices.set(engine._device, byKey);
        }
        let module = byKey.get(key);
        if (!module) {
            module = engine._device.createShaderModule({ code: makeCode() });
            byKey.set(key, module);
        }
        return module;
    };
}
