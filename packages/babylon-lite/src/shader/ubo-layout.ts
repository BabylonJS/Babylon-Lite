/**
 * UBO Layout Computation
 *
 * Computes byte offsets and generates WGSL struct bodies from UboField arrays,
 * respecting WGSL uniform buffer alignment rules (std140-like):
 *
 *   f32          → align 4,  size 4
 *   u32 / i32    → align 4,  size 4
 *   vec2<f32>    → align 8,  size 8
 *   vec3<f32>    → align 16, size 12
 *   vec4<f32>    → align 16, size 16
 *   vec4<u32>    → align 16, size 16
 *   mat4x4<f32>  → align 16, size 64
 *   array<vec4<u32>, N> → align 16, size 16 × N
 *
 * The total struct size is rounded up to a multiple of 16 bytes.
 */

import type { UboField, UboSpec, WgslScalarType } from "./fragment-types.js";

interface TypeInfo {
    readonly align: number;
    readonly size: number;
}

const TYPE_INFO: Partial<Record<WgslScalarType, TypeInfo>> = {
    f32: { align: 4, size: 4 },
    u32: { align: 4, size: 4 },
    i32: { align: 4, size: 4 },
    "vec2<f32>": { align: 8, size: 8 },
    "vec3<f32>": { align: 16, size: 12 },
    "vec4<f32>": { align: 16, size: 16 },
    "vec4<u32>": { align: 16, size: 16 },
    "mat4x4<f32>": { align: 16, size: 64 },
};

function alignUp(offset: number, alignment: number): number {
    return (offset + alignment - 1) & ~(alignment - 1);
}

function typeInfo(type: WgslScalarType): TypeInfo {
    const info = TYPE_INFO[type];
    if (info) {
        return info;
    }
    const m = /^array<vec4<u32>,\s*(\d+)>$/.exec(type);
    if (m) {
        return { align: 16, size: Number(m[1]) * 16 };
    }
    throw new Error(`Unknown UBO field type: ${type}`);
}

/**
 * Compute the UBO byte layout from an ordered array of fields.
 * Returns the total byte size, a map of field name → byte offset,
 * and the WGSL struct body string (fields only, no `struct Name {}` wrapper).
 */
export function computeUboLayout(fields: readonly UboField[]): UboSpec {
    const offsets = new Map<string, number>();
    const lines: string[] = [];
    let cursor = 0;

    for (const field of fields) {
        const info = typeInfo(field.type);

        cursor = alignUp(cursor, info.align);
        offsets.set(field.name, cursor);
        lines.push(`${field.name}: ${field.type},`);
        cursor += info.size;
    }

    // Round total size up to 16-byte boundary (required for uniform buffers)
    const totalBytes = fields.length > 0 ? alignUp(cursor, 16) : 0;

    return {
        totalBytes,
        offsets,
        structBody: lines.join("\n"),
    };
}
