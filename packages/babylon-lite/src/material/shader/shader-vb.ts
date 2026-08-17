/**
 * Module: shader-vb
 *
 * Vertex packing for geometry that is not tightly packed: an interleaved slab produced on
 * the GPU, or a caller-declared attribute format. Everything here is opt-in — the module
 * is pulled in only by `mesh-from-storage`, and it installs itself into the ShaderMaterial
 * pipeline and renderable through their module-local setters. A scene that never sources
 * geometry from a StorageBuffer proves those hooks null and keeps byte-identical output.
 *
 * The split of responsibility this module implements:
 *
 *   MATERIAL owns the FORMAT   `setShaderAttributeFormats` decides the WGSL type of
 *                              `input.<attribute>` — the shader's own signature, which
 *                              cannot depend on whichever mesh is drawn.
 *   MESH owns the PACKING      `MeshGPU._vbLayout` — the same record the glTF interleave
 *                              path produces — supplies byte stride and offset.
 *
 * Keeping them apart is what lets one material draw both a tight CPU mesh and a
 * GPU-produced slab.
 */
import type { MeshGPU, MeshVbAttr, MeshVbLayout } from "../../mesh/mesh.js";
import type { ShaderAttributeFormats, ShaderAttributeName, ShaderMaterial } from "./shader-material.js";
import type { ShaderPipelineBindings } from "./shader-pipeline.js";
import { _attributeLayout, _attributeWgslType, _installShaderVbSupport } from "./shader-pipeline.js";
import type { ShaderPacket, ShaderRenderPass } from "./shader-renderable.js";
import { _installShaderVbRenderSupport } from "./shader-renderable.js";

/** Declared formats per material.
 *
 *  A side table rather than a `ShaderMaterialOptions` field, for the same reason
 *  `setShaderTexture` and `setShaderStorageBuffer` are functions rather than options:
 *  carrying the field on every material would cost bytes in every ShaderMaterial scene,
 *  including the overwhelming majority that never declare a non-canonical format. Here
 *  the whole mechanism lives in the opt-in module and costs nothing when absent. */
const _formats = new WeakMap<ShaderMaterial, ShaderAttributeFormats>();

/** Declare non-canonical vertex formats for a material's attributes — e.g. a `float32x4`
 *  position whose `.w` carries packed per-vertex data, arriving in WGSL as
 *  `input.position : vec4<f32>`.
 *
 *  This is the shader's signature, not the geometry's packing: byte stride and offset come
 *  from the mesh, so one material can draw both a tight CPU mesh and a GPU-produced slab.
 *  Call before the material's first draw — the formats are baked into the generated WGSL
 *  prelude and the pipeline's vertex layout. */
export function setShaderAttributeFormats(material: ShaderMaterial, formats: ShaderAttributeFormats): void {
    _formats.set(material, formats);
    _enableShaderVb();
}

/** Attribute name → its slot in the mesh's interleave record. Skinning attributes have no
 *  slot: `MeshVbLayout` describes the six streams the glTF interleave path produces, and
 *  this reuses it rather than widening it. */
const VB_SLOT: Partial<Record<ShaderAttributeName, keyof MeshVbLayout>> = {
    position: "_p",
    normal: "_n",
    tangent: "_t",
    uv: "_u",
    uv2: "_u2",
    color: "_c",
};

/** Byte size of one vertex in `format` — the tight `arrayStride` when the geometry does
 *  not describe its own packing. */
function formatBytes(format: GPUVertexFormat): number {
    const componentBytes = format.includes("8") ? 1 : format.includes("16") ? 2 : 4;
    const components = format.endsWith("x2") ? 2 : format.endsWith("x3") ? 3 : format.endsWith("x4") ? 4 : 1;
    return componentBytes * components;
}

function attributeLayoutFor(material: ShaderMaterial, name: ShaderAttributeName, shaderLocation: number, vb?: MeshVbAttr): GPUVertexBufferLayout {
    const format = _formats.get(material)?.[name];
    const canonical = _attributeLayout(name, shaderLocation);
    if (!format && !vb) {
        return canonical;
    }
    const resolved = format ?? canonical.attributes[0]!.format;
    return {
        arrayStride: vb?._stride ?? formatBytes(resolved),
        attributes: [{ shaderLocation, offset: vb?._offset ?? 0, format: resolved }],
    };
}

/** WGSL type of a vertex attribute in `format`. Normalized/packed formats all expand to
 *  f32 vectors, as WebGPU defines them. */
function wgslTypeForFormat(format: GPUVertexFormat): string {
    if (format.startsWith("uint32")) {
        return format === "uint32" ? "u32" : `vec${format.slice(-1)}<u32>`;
    }
    if (format.startsWith("sint32")) {
        return format === "sint32" ? "i32" : `vec${format.slice(-1)}<i32>`;
    }
    if (format.startsWith("float32")) {
        return format === "float32" ? "f32" : `vec${format.slice(-1)}<f32>`;
    }
    return "vec4<f32>";
}

let _installed = false;

/** @internal Teach the ShaderMaterial path about declared formats and per-mesh packing.
 *  Called on first use of `createMeshFromStorageBuffer`. */
export function _enableShaderVb(): void {
    if (_installed) {
        return;
    }
    _installed = true;

    _installShaderVbSupport({
        _layouts: (material) => material.attributes.map((name, i) => attributeLayoutFor(material, name, i)),
        _wgslType: (material, name) => {
            const format = _formats.get(material)?.[name];
            return format ? wgslTypeForFormat(format) : _attributeWgslType(name);
        },
    });

    _installShaderVbRenderSupport({
        _forMesh: (material: ShaderMaterial, _bindings: ShaderPipelineBindings, mesh) => {
            const layout = mesh._gpu._vbLayout;
            const key = mesh._gpu._vbKey;
            if (!layout || !key) {
                return null;
            }
            const vbs = material.attributes.map((name, i) => {
                const slot = VB_SLOT[name];
                return attributeLayoutFor(material, name, i, slot ? layout[slot] : undefined);
            });
            return { _vbs: vbs, _key: key };
        },
        _group: (packets: readonly ShaderPacket[]) => {
            const first = packets[0]?.mesh._gpu._vbKey;
            let mixed = false;
            for (const p of packets) {
                if (p.mesh._gpu._vbKey !== first) {
                    mixed = true;
                    break;
                }
            }
            // Uniform packing (including all-tight) — let the caller keep its single-group path.
            if (!mixed) {
                return null;
            }
            const byKey = new Map<string, ShaderPacket[]>();
            for (const p of packets) {
                const k = p.mesh._gpu._vbKey ?? "";
                const group = byKey.get(k);
                if (group) {
                    group.push(p);
                } else {
                    byKey.set(k, [p]);
                }
            }
            return [...byKey.values()];
        },
        _draw: (pass: ShaderRenderPass, gpu: MeshGPU) => {
            // `_baseVertex` addresses this mesh's slot inside a shared vertex allocation.
            // Applied through the draw call rather than a non-zero `setVertexBuffer` bind
            // offset, which corrupts vertex fetch on some AMD/Dawn paths.
            if (gpu._baseVertex) {
                pass.drawIndexed(gpu.indexCount, 1, 0, gpu._baseVertex);
            } else {
                pass.drawIndexed(gpu.indexCount);
            }
        },
    });
}
