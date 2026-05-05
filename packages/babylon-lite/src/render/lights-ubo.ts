/** Shared lights UBO helpers — used by both Standard and PBR pipelines.
 *
 *  UBO layout: 16-byte header (u32 count + 3×u32 padding) followed by
 *  up to MAX_LIGHTS × LightEntry (4 × vec4 = 64 bytes each).
 *  Default total: 16 + 16 × 64 = 1040 bytes. */

import type { EngineContextInternal } from "../engine/engine.js";
import type { LightBase } from "../light/types.js";
import type { LightBaseInternal } from "../light/types.js";
import { MAX_LIGHTS, LIGHT_ENTRY_FLOATS } from "../light/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { createUniformBuffer } from "../resource/gpu-buffers.js";
import type { SceneContextInternal } from "../scene/scene-core.js";
import type { UboField } from "../shader/fragment-types.js";

/** Reusable typed-array pair for writing a u32 count as its float32 bit pattern.
 *  Avoids allocating a Uint32Array view on every fillLightsData call. */
const _countU32 = new Uint32Array(1);
const _countF32 = new Float32Array(_countU32.buffer);

const MESH_LIGHT_INDEX_WORD_OFFSET = 20; // world matrix (16 u32) + lc (1 u32) + uniform padding (3 u32)

function meshLightIndexVec4Count(): number {
    return Math.ceil(MAX_LIGHTS / 4);
}

/** @internal
 * Total byte size of the lights UBO (header + MAX_LIGHTS entries).
 * Recomputed dynamically because MAX_LIGHTS is mutable via `setMaxLights`. */
export function getLightsUboSize(): number {
    return 16 + MAX_LIGHTS * LIGHT_ENTRY_FLOATS * 4;
}

/** Compute a composite version from all lights (sum of _lightVersion).
 *  Returns 0 for lights without version tracking (always refresh). */
function computeLightsVersion(lights: readonly LightBase[]): number {
    let v = 0;
    for (const light of lights) {
        v += (light as LightBaseInternal)._lightVersion ?? 0;
    }
    return v;
}

/** Fill a Float32Array with standard light data. Reused by create and refresh paths. */
function fillLightsData(data: Float32Array, lights: readonly LightBase[]): void {
    data.fill(0);
    let count = 0;
    const headerFloats = 4; // count + 3 padding
    for (const light of lights) {
        if (count >= MAX_LIGHTS) {
            break;
        }
        const li = light as LightBaseInternal;
        if (!li._writeLightUbo) {
            continue;
        }
        li._writeLightUbo(data, headerFloats + count * LIGHT_ENTRY_FLOATS);
        count++;
    }
    // Write count as u32 bit pattern into the first float slot (zero allocation)
    _countU32[0] = count;
    data[0] = _countF32[0]!;
}

/** @internal */
export interface SceneLightGpuState {
    _buffer: GPUBuffer;
    _scratch: Float32Array;
    _version: number;
    _lightCount: number;
    _byteSize: number;
}

/** @internal */
export function ensureSceneLightState(engine: EngineContextInternal, scene: SceneContextInternal): SceneLightGpuState {
    let state = scene._lightGpuState;
    const byteSize = getLightsUboSize();
    if (state && state._byteSize === byteSize) {
        return state;
    }
    const registerDisposer = !state;
    state?._buffer.destroy();
    const scratch = new Float32Array(byteSize / 4);
    fillLightsData(scratch, scene.lights);
    state = {
        _buffer: createUniformBuffer(engine, scratch),
        _scratch: scratch,
        _version: computeLightsVersion(scene.lights),
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
export function refreshSceneLightsUBO(engine: EngineContextInternal, scene: SceneContextInternal): GPUBuffer {
    const state = ensureSceneLightState(engine, scene);
    const version = computeLightsVersion(scene.lights);
    if (version !== state._version || scene.lights.length !== state._lightCount) {
        state._version = version;
        state._lightCount = scene.lights.length;
        fillLightsData(state._scratch, scene.lights);
        engine.device.queue.writeBuffer(state._buffer, 0, state._scratch as Float32Array<ArrayBuffer>);
    }
    return state._buffer;
}

/** @internal */
export function appendMeshLightUboFields(fields: UboField[]): void {
    fields.push({ name: "lc", type: "u32" });
    fields.push({ name: "li", type: `array<vec4<u32>, ${meshLightIndexVec4Count()}>` });
}

/** @internal */
export function meshLightIndexWGSL(meshVar: string, functionName = "mli"): string {
    return `fn ${functionName}(i: u32) -> u32 { return ${meshVar}.li[i / 4u][i % 4u]; }`;
}

function affectsMesh(light: LightBase, mesh: Mesh): boolean {
    const meshId = mesh.id;
    const included = light.includedOnlyMeshIds;
    if (included?.size) {
        return !!meshId && included.has(meshId);
    }
    return !meshId || !light.excludedMeshIds?.has(meshId);
}

/** @internal
 * Writes mesh light indices when data is provided. Return encoding:
 * 0 = no lights, N > 0 = one light at index N - 1, N < 0 = -affectedCount. */
export function writeMeshLightSelection(mesh: Mesh, lights: readonly LightBase[], data?: Float32Array): number {
    const u32 = data ? new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4) : null;
    let count = 0;
    let single = -1;
    let pi = 0;
    for (const light of lights) {
        if (pi >= MAX_LIGHTS) {
            break;
        }
        if (!(light as LightBaseInternal)._writeLightUbo) {
            continue;
        }
        if (affectsMesh(light, mesh)) {
            single = pi;
            if (u32) {
                u32[MESH_LIGHT_INDEX_WORD_OFFSET + count] = pi;
            }
            count++;
        }
        pi++;
    }
    if (u32) {
        u32[16] = count;
        for (let i = count; i < MAX_LIGHTS; i++) {
            u32[MESH_LIGHT_INDEX_WORD_OFFSET + i] = 0;
        }
    }
    return count === 1 ? single + 1 : -count;
}
