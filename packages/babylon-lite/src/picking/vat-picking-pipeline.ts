/** VAT mesh projection for the unified GPU picker.
 *
 * This module is lazy-imported only when a pickable mesh owns VAT data. Shader deformation comes
 * directly from the VAT material fragment owner; this file only supplies the pick pipeline's
 * vertex layouts and binds the same mesh resources used by visible rendering.
 */

import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import { _getStorageBufferHandle } from "../resource/storage-buffer.js";
import { createVatPickProjectionWgsl } from "../material/pbr/fragments/vat-fragment.js";
import type { PickingVertexProjection } from "./picking-advanced-pipeline.js";

let _device: GPUDevice | null = null;
let _projections: Map<string, PickingVertexProjection> | null = null;

function skinInputs(has8Bones: boolean): string {
    return `, @location(1) joints: vec4<u32>, @location(2) weights: vec4<f32>${has8Bones ? ", @location(3) joints1: vec4<u32>, @location(4) weights1: vec4<f32>" : ""}`;
}

function skinLayouts(has8Bones: boolean): GPUVertexBufferLayout[] {
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

function createProjection(engine: EngineContext, has8Bones: boolean, instanceStorage: boolean): PickingVertexProjection {
    const device = engine._device;
    const source = createVatPickProjectionWgsl(has8Bones, instanceStorage);
    const regularBGL = device.createBindGroupLayout({
        label: `picking-vat-${has8Bones ? 8 : 4}-regular-bgl`,
        entries: [
            { binding: 0, visibility: SS.VERTEX, texture: { sampleType: "unfilterable-float" } },
            { binding: 1, visibility: SS.VERTEX, buffer: { type: "uniform" } },
        ],
    });
    const thinBGL = device.createBindGroupLayout({
        label: `picking-vat-${has8Bones ? 8 : 4}-thin-bgl`,
        entries: [
            { binding: 0, visibility: SS.VERTEX, texture: { sampleType: "unfilterable-float" } },
            { binding: 1, visibility: SS.VERTEX, buffer: { type: "uniform" } },
            instanceStorage
                ? { binding: 2, visibility: SS.VERTEX, buffer: { type: "read-only-storage" } }
                : { binding: 2, visibility: SS.VERTEX, texture: { sampleType: "unfilterable-float" } },
        ],
    });
    const commonDeclarations = `${source.helpers}
@group(3) @binding(0) var vatSampler: texture_2d<f32>;
@group(3) @binding(1) var<uniform> vat: vatUniforms;`;
    return {
        key: `vat-${has8Bones ? 8 : 4}-${instanceStorage ? "storage" : "texture"}`,
        shader: {
            regularDeclarations: commonDeclarations,
            thinDeclarations: `${commonDeclarations}
@group(3) @binding(2) ${instanceStorage ? "var<storage, read> vatInstanceStorage: array<vec4<f32>>;" : "var vatInstanceTex: texture_2d<f32>;"}`,
            regularInputs: skinInputs(has8Bones),
            thinInputs: skinInputs(has8Bones),
            regularBody: source.regularBody,
            thinBody: source.thinBody,
        },
        vertexBuffers: skinLayouts(has8Bones),
        regularBGL,
        thinBGL,
    };
}

function projectionFor(engine: EngineContext, has8Bones: boolean, instanceStorage: boolean): PickingVertexProjection {
    if (_device !== engine._device) {
        _device = engine._device;
        _projections = null;
    }
    const key = `${has8Bones ? 8 : 4}-${instanceStorage ? "storage" : "texture"}`;
    const projections = (_projections ??= new Map());
    let projection = projections.get(key);
    if (!projection) {
        projection = createProjection(engine, has8Bones, instanceStorage);
        projections.set(key, projection);
    }
    return projection;
}

/** Return the exact VAT projection for this mesh, or null while an instanced VAT texture is unavailable. */
export function getVatPickingProjection(engine: EngineContext, mesh: Mesh): PickingVertexProjection | null {
    const vat = mesh.vat;
    const instanceStorage = !!vat?._instanceStorage;
    if (!vat || (mesh.thinInstances && !instanceStorage && !vat.instanceTexture)) {
        return null;
    }
    return projectionFor(engine, vat.joints1Buffer !== null && vat.weights1Buffer !== null, instanceStorage);
}

/** Bind VAT resources and skin attributes after the picker's position/optional payload vertex slots. */
export function bindVatPickingProjection(engine: EngineContext, pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, mesh: Mesh, thin: boolean, firstVertexSlot: number): void {
    const vat = mesh.vat;
    if (!vat) {
        return;
    }
    const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: vat.texture.createView() },
        { binding: 1, resource: { buffer: vat.settingsBuffer } },
    ];
    if (thin) {
        if (vat._instanceStorage) {
            entries.push({ binding: 2, resource: { buffer: _getStorageBufferHandle(engine, vat._instanceStorage) } });
        } else if (vat.instanceTexture) {
            entries.push({ binding: 2, resource: vat.instanceTexture.createView() });
        } else {
            return;
        }
    }
    pass.setBindGroup(
        3,
        engine._device.createBindGroup({
            label: `picking-vat-${thin ? "thin" : "regular"}-bg`,
            layout: pipeline.getBindGroupLayout(3),
            entries,
        })
    );
    let slot = firstVertexSlot;
    pass.setVertexBuffer(slot++, vat.jointsBuffer);
    pass.setVertexBuffer(slot++, vat.weightsBuffer);
    if (vat.joints1Buffer && vat.weights1Buffer) {
        pass.setVertexBuffer(slot++, vat.joints1Buffer);
        pass.setVertexBuffer(slot, vat.weights1Buffer);
    }
}
