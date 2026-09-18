import type { MeshVbLayout } from "./mesh.js";

/** @internal Apply mesh-owned packing to already-built one-layout-per-attribute pipelines. */
export function applyMeshVertexBufferLayout(layouts: readonly GPUVertexBufferLayout[], attributeNames: readonly string[], layout?: MeshVbLayout): readonly GPUVertexBufferLayout[] {
    return layout
        ? layouts.map((current, index) => {
              const name = attributeNames[index];
              const meshLayout = name && current.stepMode !== "instance" ? layout[name] : undefined;
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
