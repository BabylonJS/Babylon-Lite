/** Live skeletal-skinning and morph-target projection for the GPU picker.
 *
 * Lazy-imported only when a pickable mesh carries a live skeleton or morph targets. The pick pass
 * deforms vertices in its own vertex shader from the same bone texture and morph storage buffers the
 * render path binds, so a pick sees exactly the pose on screen with no CPU-side per-vertex work.
 *
 * The skinning WGSL is imported from the shared render fragment rather than restated here, so the
 * pick pose can never drift from the rendered pose.
 */

import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import { SKELETON_HELPERS, makeSkinningCode } from "../shader/fragments/skeleton-fragment.js";
import type { PickingVertexProjection } from "./picking-advanced-pipeline.js";

let _device: GPUDevice | null = null;
let _projections: Map<string, PickingVertexProjection> | null = null;

/** Morph storage-buffer layout. Restated here rather than imported from `morph-fragment-core.ts`:
 *  that module belongs to the material chunk, and importing one string from it splits it into a
 *  separate shared chunk that every morph render scene then pays for. Must stay byte-compatible with
 *  the `_vertexHelperFunctions` declarations there — both views read the same buffers. */
const MORPH_STRUCTS = `struct morphUniforms {
count: u32,
vertexCount: u32,
_p0: u32,
_p1: u32,
weights: array<f32>,
}
struct morphDeltasUniforms {
d: array<f32>,
}`;

/** Position-only morph accumulation. The render fragment also accumulates normal deltas; picking never
 *  needs normals, so this reads only the position half of each 6-float (position xyz, normal xyz)
 *  delta record. The stride and weight indexing match `morph-fragment-core.ts` exactly. */
const MORPH_POSITION = `var morphedPos = position;
for (var i = 0u; i < morph.count; i = i + 1u) {
let b = (i * morph.vertexCount + vertexIndex) * 6u;
morphedPos = morphedPos + morph.weights[i] * vec3<f32>(morphDeltas.d[b], morphDeltas.d[b + 1u], morphDeltas.d[b + 2u]);
}`;

function declarations(skeleton: boolean, morph: boolean): string {
    const parts: string[] = [];
    let binding = 0;
    if (skeleton) {
        parts.push(SKELETON_HELPERS, `@group(3) @binding(${binding++}) var boneSampler: texture_2d<f32>;`);
    }
    if (morph) {
        parts.push(
            MORPH_STRUCTS,
            `@group(3) @binding(${binding++}) var<storage, read> morphDeltas: morphDeltasUniforms;`,
            `@group(3) @binding(${binding}) var<storage, read> morph: morphUniforms;`
        );
    }
    return parts.join("\n");
}

function inputs(skeleton: boolean, has8Bones: boolean, morph: boolean): string {
    let source = "";
    if (skeleton) {
        source += ", @location(1) joints: vec4<u32>, @location(2) weights: vec4<f32>";
        if (has8Bones) {
            source += ", @location(3) joints1: vec4<u32>, @location(4) weights1: vec4<f32>";
        }
    }
    if (morph) {
        source += ", @builtin(vertex_index) vertexIndex: u32";
    }
    return source;
}

function body(skeleton: boolean, has8Bones: boolean, morph: boolean, worldExpr: string): string {
    const parts: string[] = [];
    if (morph) {
        parts.push(MORPH_POSITION);
    }
    if (skeleton) {
        parts.push(`var finalWorld = ${worldExpr};`, makeSkinningCode(has8Bones, worldExpr));
    }
    const transform = skeleton ? "finalWorld" : worldExpr;
    parts.push(`let projectedTransform = ${transform};`, `let projectedWorld = (${transform} * vec4f(${morph ? "morphedPos" : "position"}, 1.0)).xyz;`);
    return parts.join("\n");
}

function skinLayouts(skeleton: boolean, has8Bones: boolean): GPUVertexBufferLayout[] {
    if (!skeleton) {
        return [];
    }
    const layouts: GPUVertexBufferLayout[] = [
        { arrayStride: 16, attributes: [{ shaderLocation: 1, offset: 0, format: "uint32x4" }] },
        { arrayStride: 16, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x4" }] },
    ];
    if (has8Bones) {
        layouts.push(
            { arrayStride: 16, attributes: [{ shaderLocation: 3, offset: 0, format: "uint32x4" }] },
            { arrayStride: 16, attributes: [{ shaderLocation: 4, offset: 0, format: "float32x4" }] }
        );
    }
    return layouts;
}

function createProjection(engine: EngineContext, skeleton: boolean, has8Bones: boolean, morph: boolean): PickingVertexProjection {
    const entries: GPUBindGroupLayoutEntry[] = [];
    let binding = 0;
    if (skeleton) {
        entries.push({ binding: binding++, visibility: SS.VERTEX, texture: { sampleType: "unfilterable-float" } });
    }
    if (morph) {
        entries.push(
            { binding: binding++, visibility: SS.VERTEX, buffer: { type: "read-only-storage" } },
            { binding, visibility: SS.VERTEX, buffer: { type: "read-only-storage" } }
        );
    }
    const key = `deform-${skeleton ? (has8Bones ? "skin8" : "skin4") : "noskin"}-${morph ? "morph" : "nomorph"}`;
    const bgl = engine._device.createBindGroupLayout({ label: `picking-${key}-bgl`, entries });
    const shared = declarations(skeleton, morph);
    const sharedInputs = inputs(skeleton, has8Bones, morph);
    return {
        key,
        shader: {
            regularDeclarations: shared,
            thinDeclarations: shared,
            regularInputs: sharedInputs,
            thinInputs: sharedInputs,
            regularBody: body(skeleton, has8Bones, morph, "mesh.world"),
            thinBody: body(skeleton, has8Bones, morph, "world"),
        },
        vertexBuffers: skinLayouts(skeleton, has8Bones),
        regularBGL: bgl,
        thinBGL: bgl,
    };
}

function projectionFor(engine: EngineContext, skeleton: boolean, has8Bones: boolean, morph: boolean): PickingVertexProjection {
    if (_device !== engine._device) {
        _device = engine._device;
        _projections = null;
    }
    const key = `${skeleton ? (has8Bones ? 8 : 4) : 0}-${morph ? 1 : 0}`;
    const projections = (_projections ??= new Map());
    let projection = projections.get(key);
    if (!projection) {
        projection = createProjection(engine, skeleton, has8Bones, morph);
        projections.set(key, projection);
    }
    return projection;
}

/** Return the pick projection matching this mesh's live deformation, or null when it has none.
 *  VAT meshes are excluded — their baked animation owns the projection slot instead. */
export function getDeformPickingProjection(engine: EngineContext, mesh: Mesh): PickingVertexProjection | null {
    if (mesh.vat) {
        return null;
    }
    const skeleton = mesh.skeleton ?? null;
    const morph = mesh.morphTargets ?? null;
    if (!skeleton && !morph) {
        return null;
    }
    return projectionFor(engine, !!skeleton, !!(skeleton?.joints1Buffer && skeleton.weights1Buffer), !!morph);
}

/** Bind the bone texture, morph storage, and skin attributes for a deformed pick draw.
 *
 *  The projection always occupies group 3, so group 2 is part of the pipeline layout even when no
 *  discard rule supplies one. WebGPU requires every declared group to be bound, so an empty group is
 *  supplied here whenever the caller has not already bound a discard group. */
export function bindDeformPickingProjection(
    engine: EngineContext,
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    mesh: Mesh,
    firstVertexSlot: number,
    discardGroupBound: boolean
): void {
    const skeleton = mesh.skeleton;
    const morph = mesh.morphTargets;
    const entries: GPUBindGroupEntry[] = [];
    let binding = 0;
    if (skeleton) {
        entries.push({ binding: binding++, resource: skeleton.boneTexture.createView() });
    }
    if (morph) {
        entries.push({ binding: binding++, resource: { buffer: morph.deltasBuffer } }, { binding, resource: { buffer: morph.weightsBuffer } });
    }
    if (!discardGroupBound) {
        pass.setBindGroup(2, engine._device.createBindGroup({ label: "picking-deform-empty-bg", layout: pipeline.getBindGroupLayout(2), entries: [] }));
    }
    pass.setBindGroup(3, engine._device.createBindGroup({ label: "picking-deform-bg", layout: pipeline.getBindGroupLayout(3), entries }));
    if (skeleton) {
        let slot = firstVertexSlot;
        pass.setVertexBuffer(slot++, skeleton.jointsBuffer);
        pass.setVertexBuffer(slot++, skeleton.weightsBuffer);
        if (skeleton.joints1Buffer && skeleton.weights1Buffer) {
            pass.setVertexBuffer(slot++, skeleton.joints1Buffer);
            pass.setVertexBuffer(slot, skeleton.weights1Buffer);
        }
    }
}
