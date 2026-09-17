/**
 * Module: shader-vb
 *
 * Vertex packing for geometry that is not tightly packed: an interleaved slab produced on
 * the GPU, or a caller-declared attribute format. Everything here is opt-in — the module
 * is pulled in only by `mesh-from-storage`, and it installs one support record into the
 * small shared seam consumed by the lazy ShaderMaterial pipeline and renderable modules.
 *
 * The split of responsibility this module implements:
 *
 *   MATERIAL owns the FORMAT   `setShaderAttributeFormats` decides the WGSL type of
 *                              `input.<attribute>` — the shader's own signature, which
 *                              cannot depend on whichever mesh is drawn.
 *   MESH owns the PACKING      `MeshGPU._vbLayout` — the same record the glTF interleave
 *                              path produces — supplies byte stride and offset.
 *
 * One material can serve different packing only when the physical attribute formats
 * are compatible. Canonical CPU geometry does not become a different encoding.
 */
import type { Mesh, MeshVbAttr } from "../../mesh/mesh.js";
import type { ShaderAttributeFormats, ShaderMaterial } from "./shader-material.js";
import {
    _attributeInfo,
    _attributeLayout,
    _createAttributeLayout,
    _installShaderVbSupport,
    type ShaderVbPacket,
    type ShaderVbSupport,
    type ShaderAttributeBufferGetter,
} from "./shader-vb-support.js";

/** Declare non-canonical vertex formats for a material's attributes — e.g. a `float32x4`
 *  position whose `.w` carries packed per-vertex data, arriving in WGSL as
 *  `input.position : vec4<f32>`.
 *
 *  This is the shader's signature, not the geometry's packing: byte stride and offset come
 *  from the mesh. Reuse across meshes requires compatible physical formats.
 *  Call before registering or preparing the material — the formats are baked into the
 *  generated WGSL prelude and the pipeline's vertex layout. */
export function setShaderAttributeFormats(material: ShaderMaterial, formats: ShaderAttributeFormats): void {
    material._attributeFormats = { ...formats };
    _enableShaderVb();
}

function formatComponents(format: GPUVertexFormat): number {
    return format.startsWith("unorm10") ? 4 : format.includes("x2") ? 2 : format.includes("x3") ? 3 : format.includes("x4") ? 4 : 1;
}

/** Byte size of one vertex in `format` — the tight `arrayStride` when the geometry does
 *  not describe its own packing. */
function formatByteLength(format: GPUVertexFormat): number {
    if (format.startsWith("unorm10")) {
        return 4;
    }
    const componentBytes = format.includes("8") ? 1 : format.includes("16") ? 2 : 4;
    return componentBytes * formatComponents(format);
}

/** WGSL type of a vertex attribute in `format`, per the WebGPU vertex-format-to-shader-type
 *  table: `uint*` formats expand to `u32`/`vecN<u32>`, `sint*` formats expand to
 *  `i32`/`vecN<i32>`, and every normalized/float/packed format (`unorm*`, `snorm*`,
 *  `float16*`, `float32*`, and the two packed 4-component forms) expands to
 *  `f32`/`vecN<f32>`. Component count comes from the format itself, not a fixed default. */
function wgslTypeForFormat(format: GPUVertexFormat): string {
    const components = formatComponents(format);
    const scalar = format.startsWith("uint") ? "u32" : format.startsWith("sint") ? "i32" : "f32";
    return components === 1 ? scalar : `vec${components}<${scalar}>`;
}

function validateMeshFormats(material: ShaderMaterial, mesh: Mesh, getAttribute: ShaderAttributeBufferGetter): number {
    const gpu = mesh._gpu;
    const formats = material._attributeFormats;
    if (!formats && !gpu._vbLayout) {
        return 0;
    }
    const storage = gpu._vertexCount !== undefined;
    const attributes = material.attributes;
    let missing = 0;
    for (let index = 0; index < attributes.length; index++) {
        const name = attributes[index]!;
        const declared = formats?.[name];
        const packing = gpu._vbLayout?.[name];
        const buffer = getAttribute(mesh, name);
        const canonicalFormat = _attributeInfo(name)._format;
        if (declared && (!storage || (!packing && buffer)) && declared !== canonicalFormat) {
            throw new Error(`ShaderMaterial format "${declared}" for "${name}" is incompatible with canonical geometry on mesh "${mesh.name}".`);
        }
        if (!buffer || !packing) {
            if (!buffer && storage) {
                missing |= 1 << index;
            }
            continue;
        }
        const format = declared ?? canonicalFormat;
        const { _stride: stride, _offset: offset } = packing;
        const bytes = formatByteLength(format);
        if (offset % Math.min(4, bytes) !== 0 || (stride !== 0 && offset + bytes > stride)) {
            throw new Error(`ShaderMaterial format "${format}" for "${name}" does not fit the aligned vertex layout on mesh "${mesh.name}".`);
        }
    }
    return missing;
}

const ZERO_LAYOUT: MeshVbAttr = { _stride: 0, _offset: 0 };

function vertexKey(mesh: Mesh, missing: number): string {
    return (mesh._gpu._vbKey ?? "") + (missing ? `:zero${missing}` : "");
}

function packetVertexKey(packet: ShaderVbPacket): string {
    return vertexKey(packet.mesh, packet._vertexMask ?? 0);
}

function groupPackets<T extends ShaderVbPacket>(packets: readonly T[]): Iterable<readonly T[]> | null {
    const firstPacket = packets[0];
    const first = firstPacket ? packetVertexKey(firstPacket) : "";
    for (const packet of packets) {
        if (packetVertexKey(packet) !== first) {
            const byKey = new Map<string, T[]>();
            for (const groupedPacket of packets) {
                const key = packetVertexKey(groupedPacket);
                const group = byKey.get(key);
                if (group) {
                    group.push(groupedPacket);
                } else {
                    byKey.set(key, [groupedPacket]);
                }
            }
            return byKey.values();
        }
    }
    return null;
}

/** @internal Teach the ShaderMaterial path about declared formats and per-mesh packing.
 *  Called on first use of `createMeshFromStorageBuffer`. */
export function _enableShaderVb(): void {
    _installShaderVbSupport(support);
}

const support: ShaderVbSupport = {
    _validateMesh: validateMeshFormats,
    _layouts: (material) =>
        material.attributes.map((name, shaderLocation) => {
            const format = material._attributeFormats?.[name];
            return format ? _createAttributeLayout(format, (formatByteLength(format) + 3) & ~3, shaderLocation) : _attributeLayout(name, shaderLocation);
        }),
    _wgslType: (material, name) => {
        const format = material._attributeFormats?.[name];
        return format ? wgslTypeForFormat(format) : undefined;
    },
    _forMesh: (material, bindings, mesh, missing) => {
        const layout = mesh._gpu._vbLayout;
        if (!layout && !missing) {
            return null;
        }
        const attributes = material.attributes;
        const vbs = bindings.vertexBuffers.map((canonical, i) => {
            const packing = missing & (1 << i) ? ZERO_LAYOUT : layout?.[attributes[i]!];
            return packing ? { ...canonical, arrayStride: packing._stride, attributes: [{ ...canonical.attributes[0]!, offset: packing._offset }] } : canonical;
        });
        return { _vbs: vbs, _key: vertexKey(mesh, missing) };
    },
    _group: groupPackets,
};
