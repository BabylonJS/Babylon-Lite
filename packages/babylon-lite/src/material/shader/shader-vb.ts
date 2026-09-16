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
import type { Mesh, MeshGPU, MeshVbAttr, MeshVbLayout } from "../../mesh/mesh.js";
import type { ShaderAttributeFormats, ShaderAttributeName, ShaderMaterial } from "./shader-material.js";
import type { ShaderPipelineBindings } from "./shader-pipeline.js";
import { _attributeLayout, _attributeWgslType, _installShaderVbSupport } from "./shader-pipeline.js";
import type { ShaderPacket, ShaderRenderPass } from "./shader-renderable.js";
import { _getShaderAttributeBuffer, _installShaderVbRenderSupport } from "./shader-renderable.js";
import { _vertexDefaults } from "../../mesh/vertex-defaults-hooks.js";
import { drawMeshIndexed } from "../../mesh/mesh-vertex-layout.js";

/** Declare non-canonical vertex formats for a material's attributes — e.g. a `float32x4`
 *  position whose `.w` carries packed per-vertex data, arriving in WGSL as
 *  `input.position : vec4<f32>`.
 *
 *  This is the shader's signature, not the geometry's packing: byte stride and offset come
 *  from the mesh, so one material can draw both a tight CPU mesh and a GPU-produced slab.
 *  Call before the material's first draw — the formats are baked into the generated WGSL
 *  prelude and the pipeline's vertex layout. */
export function setShaderAttributeFormats(material: ShaderMaterial, formats: ShaderAttributeFormats): void {
    material._attributeFormats = formats;
    _enableShaderVb();
}

/** Attribute name → its slot in the mesh's interleave record. */
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
    if (format.startsWith("unorm10")) {
        return 4;
    }
    const componentBytes = format.includes("8") ? 1 : format.includes("16") ? 2 : 4;
    const components = format.includes("x2") ? 2 : format.includes("x3") ? 3 : format.includes("x4") ? 4 : 1;
    return (componentBytes * components + 3) & ~3;
}

function attributeLayoutFor(material: ShaderMaterial, name: ShaderAttributeName, shaderLocation: number, vb?: MeshVbAttr): GPUVertexBufferLayout {
    const format = material._attributeFormats?.[name];
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

/** WGSL type of a vertex attribute in `format`, per the WebGPU vertex-format-to-shader-type
 *  table: `uint*` formats expand to `u32`/`vecN<u32>`, `sint*` formats expand to
 *  `i32`/`vecN<i32>`, and every normalized/float/packed format (`unorm*`, `snorm*`,
 *  `float16*`, `float32*`, and the two packed 4-component forms) expands to
 *  `f32`/`vecN<f32>`. Component count comes from the format itself, not a fixed default. */
function wgslTypeForFormat(format: GPUVertexFormat): string {
    const components = format.startsWith("unorm10") ? 4 : format.includes("x2") ? 2 : format.includes("x3") ? 3 : format.includes("x4") ? 4 : 1;
    const scalar = format.startsWith("uint") ? "u32" : format.startsWith("sint") ? "i32" : "f32";
    return components === 1 ? scalar : `vec${components}<${scalar}>`;
}

let _installed = false;

const ZERO_LAYOUT: MeshVbAttr = { _stride: 0, _offset: 0 };

function missingAttributes(material: ShaderMaterial, mesh: Mesh): number {
    if (!_vertexDefaults || mesh._gpu._vertexCount === undefined) {
        return 0;
    }
    let mask = 0;
    for (let index = 0; index < material.attributes.length; index++) {
        if (!_getShaderAttributeBuffer(mesh, material.attributes[index]!)) {
            mask |= 1 << index;
        }
    }
    return mask;
}

function vertexKey(material: ShaderMaterial, mesh: Mesh, missing = missingAttributes(material, mesh)): string {
    return (mesh._gpu._vbKey ?? "") + (missing ? `:zero${missing}` : "");
}

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
            const format = material._attributeFormats?.[name];
            return format ? wgslTypeForFormat(format) : _attributeWgslType(name);
        },
    });

    _installShaderVbRenderSupport({
        _forMesh: (material: ShaderMaterial, _bindings: ShaderPipelineBindings, mesh) => {
            if (!mesh) {
                return null;
            }
            const layout = mesh._gpu._vbLayout;
            const missing = missingAttributes(material, mesh);
            const key = vertexKey(material, mesh, missing);
            if (!key || (!layout && !missing)) {
                return null;
            }
            const vbs = material.attributes.map((name, i) => {
                const slot = VB_SLOT[name];
                return attributeLayoutFor(material, name, i, missing & (1 << i) ? ZERO_LAYOUT : slot ? layout?.[slot] : undefined);
            });
            return { _vbs: vbs, _key: key };
        },
        _group: (packets: readonly ShaderPacket[], material) => {
            const first = packets[0] ? vertexKey(material, packets[0].mesh) : "";
            let mixed = false;
            for (const p of packets) {
                if (vertexKey(material, p.mesh) !== first) {
                    mixed = true;
                    break;
                }
            }
            // Uniform packing and default attributes — retain the single-group path.
            if (!mixed) {
                return null;
            }
            const byKey = new Map<string, ShaderPacket[]>();
            for (const p of packets) {
                const k = vertexKey(material, p.mesh);
                const group = byKey.get(k);
                if (group) {
                    group.push(p);
                } else {
                    byKey.set(k, [p]);
                }
            }
            return [...byKey.values()];
        },
        _zeroBuffer: (engine, gpu) => _vertexDefaults?._buffer(engine, gpu) ?? null,
        _draw: (pass: ShaderRenderPass, gpu: MeshGPU) => drawMeshIndexed(pass, gpu),
    });
}
