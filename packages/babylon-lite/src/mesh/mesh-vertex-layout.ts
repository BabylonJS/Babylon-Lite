import type { VertexAttribute } from "../shader/fragment-types.js";
import type { MeshGPU, MeshVbAttr, MeshVbLayout } from "./mesh.js";

/** Resolve one material attribute name through the mesh-owned packing contract. */
function getMeshVbAttr(layout: MeshVbLayout, name: string): MeshVbAttr | undefined {
    const key = name === "position" ? "_p" : name === "normal" ? "_n" : name === "tangent" ? "_t" : name === "uv" ? "_u" : name === "uv2" ? "_u2" : name === "color" ? "_c" : null;
    return key ? layout[key] : undefined;
}

/** @internal Apply mesh-owned packing to composer attributes before GPU layouts are emitted. */
export function applyMeshVertexLayout(attributes: readonly VertexAttribute[], layout?: MeshVbLayout): readonly VertexAttribute[] {
    return layout
        ? attributes.map((attribute) => {
              const meshLayout = attribute._stepMode === "instance" ? undefined : getMeshVbAttr(layout, attribute._name);
              return meshLayout ? { ...attribute, _arrayStride: meshLayout._stride, _offset: meshLayout._offset } : attribute;
          })
        : attributes;
}

/** @internal Apply mesh-owned packing to already-built one-layout-per-attribute pipelines. */
export function applyMeshVertexBufferLayout(layouts: readonly GPUVertexBufferLayout[], attributeNames: readonly string[], layout?: MeshVbLayout): readonly GPUVertexBufferLayout[] {
    return layout
        ? layouts.map((current, index) => {
              const name = attributeNames[index];
              const meshLayout = name && current.stepMode !== "instance" ? getMeshVbAttr(layout, name) : undefined;
              return meshLayout
                  ? {
                        ...current,
                        arrayStride: meshLayout._stride,
                        attributes: current.attributes.map((attribute) => ({ ...attribute, offset: meshLayout._offset })),
                    }
                  : current;
          })
        : layouts;
}

/** @internal Issue a direct indexed mesh draw with the mesh's shared-allocation origin. */
export function drawMeshIndexed(pass: GPURenderPassEncoder | GPURenderBundleEncoder, gpu: MeshGPU, instanceCount = 1): void {
    pass.drawIndexed(gpu.indexCount, instanceCount, 0, gpu._baseVertex);
}

/** @internal Populate the WebGPU indexed-indirect ABI, including the signed baseVertex word. */
export function writeMeshIndexedIndirectArgs(args: Uint32Array, gpu: MeshGPU, instanceCount: number): void {
    args[0] = gpu.indexCount;
    args[1] = instanceCount;
    args[2] = 0;
    args[3] = gpu._baseVertex ?? 0;
    args[4] = 0;
}
