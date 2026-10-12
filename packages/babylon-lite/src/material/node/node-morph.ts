/** MorphTargetsBlock vertex feature.
 *
 *  Loaded through the built-in `blocks/morph-targets.ts` emitter, or dynamically
 *  by the async NodeMaterial parser when a custom emitter sets the established
 *  `usesMorphTargets` flag without installing the private feature seam. Owns
 *  every morph-specific compiler declaration/layout, vertex signature parameter,
 *  per-mesh binding, and the shared zero-target fallback allocation.
 */

import { U32 } from "../../engine/typed-arrays.js";
import { BU, SS } from "../../engine/gpu-flags.js";
import type { EngineContext } from "../../engine/engine.js";
import type { Mesh } from "../../mesh/mesh.js";
import { registerManagedResourceDisposer } from "../../resource/managed-resource-hooks.js";
import { wgsl, type WgslSource } from "../../shader/wgsl.js";
import type { NodeVertexFeatureCompile } from "./node-types.js";

type EmptyMorph = readonly [device: GPUDevice, buffer: GPUBuffer];
type MorphEngine = EngineContext & { _nodeMorphFallback?: [EmptyMorph?] };

function destroyEmptyMorph(entry: EmptyMorph): void {
    entry[1].destroy();
}

function getEmptyMorph(engine: EngineContext): EmptyMorph {
    const owner = engine as MorphEngine;
    const state = owner._nodeMorphFallback;
    const cached = state?.[0];
    if (cached?.[0] === engine._device) {
        return cached;
    }

    let buffer: GPUBuffer | null = null;
    try {
        buffer = engine._device.createBuffer({ label: "node-morph-empty", size: 24, usage: BU.STORAGE | BU.COPY_DST });
        engine._device.queue.writeBuffer(buffer, 0, new U32([0, 1]));
        const entry: EmptyMorph = [engine._device, buffer];
        if (state) {
            if (cached) {
                destroyEmptyMorph(cached);
            }
            state[0] = entry;
        } else {
            const holder: [EmptyMorph?] = [entry];
            registerManagedResourceDisposer(engine, () => {
                const current = holder[0];
                if (current) {
                    destroyEmptyMorph(current);
                    holder[0] = undefined;
                }
            });
            owner._nodeMorphFallback = holder;
        }
        return entry;
    } catch (error) {
        buffer?.destroy();
        throw error;
    }
}

function morphFunction(name: "Position" | "Normal", offset: 0 | 3): WgslSource {
    const first = offset === 0 ? "b" : "b + 3u";
    return wgsl`fn nme_morph${name}(base: vec3<f32>, vi: u32) -> vec3<f32> {
    var acc = base;
    for (var i = 0u; i < morph.count; i = i + 1u) {
        let b = (i * morph.vertexCount + vi) * 6u;
        acc = acc + morph.weights[i] * vec3<f32>(morphDeltas.d[${first}], morphDeltas.d[b + ${offset + 1}u], morphDeltas.d[b + ${offset + 2}u]);
    }
    return acc;
}`;
}

/** Build the morph feature at the next free group-1 binding. */
export function createNodeMorphFeature(startBinding: number): NodeVertexFeatureCompile {
    const deltasBinding = startBinding;
    const weightsBinding = startBinding + 1;
    return [
        2,
        wgsl`struct morphDeltasUniforms { d: array<f32> };
@group(1) @binding(${deltasBinding}) var<storage, read> morphDeltas: morphDeltasUniforms;
struct morphUniforms { count: u32, vertexCount: u32, _p0: u32, _p1: u32, weights: array<f32> };
@group(1) @binding(${weightsBinding}) var<storage, read> morph: morphUniforms;
${morphFunction("Position", 0)}
${morphFunction("Normal", 3)}`,
        [
            { binding: deltasBinding, visibility: SS.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: weightsBinding, visibility: SS.VERTEX, buffer: { type: "read-only-storage" } },
        ],
        wgsl`, @builtin(vertex_index) vertexIndex: u32`,
        (engine: EngineContext, mesh: Mesh, entries: GPUBindGroupEntry[]): void => {
            const morph = mesh.morphTargets;
            const empty = morph ? null : getEmptyMorph(engine);
            entries.push({ binding: deltasBinding, resource: { buffer: morph?.deltasBuffer ?? empty![1] } });
            entries.push({ binding: weightsBinding, resource: { buffer: morph?.weightsBuffer ?? empty![1] } });
        },
    ];
}
