/** Shared lights UBO helpers — used by both Standard and PBR pipelines.
 *
 *  UBO layout: 16-byte header (u32 count + 3×u32 padding) followed by
 *  up to MAX_LIGHTS × LightEntry (4 × vec4 = 64 bytes each).
 *  Total: 16 + 4 × 64 = 272 bytes. */

import type { EngineContextInternal } from "../engine/engine.js";
import type { LightBase } from "../light/types.js";
import type { LightBaseInternal } from "../light/types.js";
import { MAX_LIGHTS, LIGHT_ENTRY_FLOATS } from "../light/types.js";
import { createUniformBuffer } from "../resource/gpu-buffers.js";

/** Reusable typed-array pair for writing a u32 count as its float32 bit pattern.
 *  Avoids allocating a Uint32Array view on every fillLightsData call. */
const _countU32 = new Uint32Array(1);
const _countF32 = new Float32Array(_countU32.buffer);

/** Total byte size of the lights UBO (header + MAX_LIGHTS entries).
 *  Recomputed dynamically because MAX_LIGHTS is mutable via `setMaxLights`. */
export function getLightsUboSize(): number {
    return 16 + MAX_LIGHTS * LIGHT_ENTRY_FLOATS * 4;
}

/** @deprecated Use {@link getLightsUboSize} — this constant only reflects the
 *  MAX_LIGHTS value at module load. Retained for backwards compat; readers
 *  that call it lazily via getter will pick up runtime updates. */
export const LIGHTS_UBO_SIZE = getLightsUboSize();

/** Compute a composite version from all lights (sum of _lightVersion).
 *  Returns 0 for lights without version tracking (always refresh). */
export function computeLightsVersion(lights: readonly LightBase[]): number {
    let v = 0;
    for (const light of lights) {
        v += (light as LightBaseInternal)._lightVersion ?? 0;
    }
    return v;
}

/** Fill a Float32Array with standard light data. Reused by create and refresh paths. */
export function fillLightsData(data: Float32Array, lights: readonly LightBase[]): void {
    data.fill(0);
    let count = 0;
    const headerFloats = 4; // count + 3 padding
    for (const light of lights) {
        if (count >= MAX_LIGHTS) {
            break;
        }
        const li = light as LightBaseInternal;
        if (!li._writeStandardLightUbo) {
            continue;
        }
        li._writeStandardLightUbo(data, headerFloats + count * LIGHT_ENTRY_FLOATS);
        count++;
    }
    // Write count as u32 bit pattern into the first float slot (zero allocation)
    _countU32[0] = count;
    data[0] = _countF32[0]!;
}

/** Create a new lights UBO from all standard-compatible lights in the scene. */
export function writeLightsUBO(engine: EngineContextInternal, lights: readonly LightBase[]): GPUBuffer {
    const data = new Float32Array(getLightsUboSize() / 4);
    fillLightsData(data, lights);
    return createUniformBuffer(engine, data);
}

/** Refresh an existing lights UBO with current light state. */
export function refreshLightsUBO(engine: EngineContextInternal, buffer: GPUBuffer, lights: readonly LightBase[], scratch: Float32Array): void {
    const device = engine.device;
    fillLightsData(scratch, lights);
    device.queue.writeBuffer(buffer, 0, scratch as Float32Array<ArrayBuffer>);
}
