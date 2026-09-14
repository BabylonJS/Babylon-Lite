/** Shared lights UBO helpers — used by both Standard and PBR pipelines.
 *
 *  UBO layout: 16-byte header (u32 count + 3×u32 padding) followed by
 *  up to MAX_LIGHTS × LightEntry (4 × vec4 = 64 bytes each).
 *  Default total: 16 + 16 × 64 = 1040 bytes. */

import { F32, U32 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import type { LightBase } from "../light/types.js";
import { MAX_LIGHTS, LIGHT_ENTRY_FLOATS } from "../light/types.js";
import { createUniformBuffer } from "../resource/uniform-buffer.js";
import type { SceneContext } from "../scene/scene-core.js";

/** Reusable typed-array pair for writing a u32 count as its float32 bit pattern.
 *  Avoids allocating a Uint32Array view on every fillLightsData call. */
const _countU32 = new U32(1);
const _countF32 = new F32(_countU32.buffer);

/** @internal
 * Total byte size of the lights UBO (header + MAX_LIGHTS entries).
 * Recomputed dynamically because MAX_LIGHTS is mutable via `setMaxLights`. */
export function getLightsUboSize(): number {
    return 16 + MAX_LIGHTS * LIGHT_ENTRY_FLOATS * 4;
}

/** Compute a composite version from all lights' data and transforms. */
function computeLightsVersion(lights: readonly LightBase[]): number {
    let v = 0;
    for (const light of lights) {
        v += (light._lightVersion ?? 0) + light.worldMatrixVersion;
    }
    return v;
}

/** Fill a Float32Array with standard light data. Reused by create and refresh
 *  paths. World-space light positions are written precision-only; under
 *  floating origin the active-camera offset is subtracted afterwards by
 *  `engine._applyLightFoOffset` (kept out of non-LWR bundles). */
function fillLightsData(data: Float32Array, lights: readonly LightBase[]): void {
    data.fill(0);
    let count = 0;
    const headerFloats = 4; // count + 3 padding
    for (const light of lights) {
        if (count >= MAX_LIGHTS) {
            break;
        }
        if (!light._writeLightUbo) {
            continue;
        }
        light._writeLightUbo(data, headerFloats + count * LIGHT_ENTRY_FLOATS);
        count++;
    }
    // Write count as u32 bit pattern into the first float slot (zero allocation)
    _countU32[0] = count;
    data[0] = _countF32[0]!;
}

/** @internal */
export interface SceneLightGpuState {
    /** @internal */
    _buffer: GPUBuffer;
    /** @internal */
    _scratch: Float32Array;
    /** @internal */
    _version: number;
    /** @internal Scene light-list version the UBO was written at. Tracked SEPARATELY from `_version`:
     *  summing it into the per-light version sum lets the two cancel out (a removed light's version can
     *  offset the list bump), which would leave the removed light's data uploaded. */
    _listVersion: number;
    /** @internal */
    _lightCount: number;
    /** @internal */
    _byteSize: number;
}

/** @internal */
export function ensureSceneLightState(engine: EngineContext, scene: SceneContext): SceneLightGpuState {
    let state = scene._lightGpuState;
    const byteSize = getLightsUboSize();
    if (state && state._byteSize === byteSize) {
        return state;
    }
    const registerDisposer = !state;
    state?._buffer.destroy();
    const scratch = new F32(byteSize / 4);
    fillLightsData(scratch, scene.lights);
    engine._applyLightFoOffset?.(scratch, scene);
    state = {
        _buffer: createUniformBuffer(engine, scratch),
        _scratch: scratch,
        _version: computeLightsVersion(scene.lights) + (engine._lightFoVersion?.(scene) ?? 0),
        _listVersion: scene._lightListVersion ?? 0,
        _lightCount: scene.lights.length,
        _byteSize: byteSize,
    };
    scene._lightGpuState = state;
    if (registerDisposer) {
        scene._disposables.push(() => {
            scene._lightGpuState?._buffer.destroy();
            scene._lightGpuState = undefined;
        });
    }
    return state;
}

/** @internal */
export function refreshSceneLightsUBO(engine: EngineContext, scene: SceneContext): GPUBuffer {
    const state = ensureSceneLightState(engine, scene);
    const version = computeLightsVersion(scene.lights) + (engine._lightFoVersion?.(scene) ?? 0);
    // The per-light version sum alone cannot see a light being SWAPPED for another (same count, and the two
    // sums can match), which left the UBO holding the removed light's data. The list version is compared
    // separately rather than summed in, so the two counters can never cancel each other out.
    const listVersion = scene._lightListVersion ?? 0;
    if (version !== state._version || listVersion !== state._listVersion || scene.lights.length !== state._lightCount) {
        state._version = version;
        state._listVersion = listVersion;
        state._lightCount = scene.lights.length;
        fillLightsData(state._scratch, scene.lights);
        engine._applyLightFoOffset?.(state._scratch, scene);
        engine._device.queue.writeBuffer(state._buffer, 0, state._scratch as Float32Array<ArrayBuffer>);
    }
    return state._buffer;
}

/** @internal Fill `data` with the light-UBO contents for `foScene.lights`, then
 *  subtract the floating-origin offset of `foScene.camera` (a no-op for non-LWR
 *  engines, where `engine._applyLightFoOffset` is undefined). Reuses the same
 *  `fillLightsData` + `applyLightFoOffset` pipeline as the shared scene lights
 *  state, but lets a caller supply a DIFFERENT camera/lights source. The
 *  geometry-renderer task uses this to build a lights UBO relative to a
 *  `config.camera` override so positional light data shares the same origin as
 *  its origin-relative world/view packing — without perturbing the scene's
 *  shared lights state (which stays relative to the scene's active camera). */
export function _writeTaskLightsData(engine: EngineContext, data: Float32Array, foScene: SceneContext): void {
    fillLightsData(data, foScene.lights);
    engine._applyLightFoOffset?.(data, foScene);
}
