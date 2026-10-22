/** Geometry export: one glTF primitive per Lite mesh, from the retained CPU arrays. */

import type { Mesh } from "../mesh/mesh.js";
import type { ExportContext, UvState } from "./export-context.js";
import { cachedAccessor } from "./export-context.js";
import { ARRAY_BUFFER, computeMinMax, ELEMENT_ARRAY_BUFFER, FLOAT, UNSIGNED_INT, UNSIGNED_SHORT } from "./export-buffers.js";
import type { GltfAccessorType, GltfAttributes, GltfPrimitive } from "./export-gltf-types.js";
import { needsWindingFlip } from "./export-handedness.js";

/** @internal One exported primitive, before its material is attached. */
export interface ExportedPrimitive {
    readonly primitive: GltfPrimitive;
    /** How the mesh's second UV set exports; selects the material variant. */
    readonly uvState: UvState;
    /** Current morph weights (one per exported target), when the mesh has morph targets. */
    readonly weights?: number[];
    /** Number of vertices; used to synthesize UVs a textured material needs. */
    readonly vertexCount: number;
}

/** Mesh fields the exporter reads that are not declared on the public `Mesh` interface. */
type MeshExportView = Mesh & { readonly _flatNormal?: boolean; readonly _primitive?: GPUPrimitiveState };

/** @internal Emit the primitive for one Lite mesh (synchronous). Returns null, after logging when
 *  the cause is unexpected, when the mesh has no exportable CPU geometry. */
export function exportPrimitive(ctx: ExportContext, mesh: Mesh, convert: boolean): ExportedPrimitive | null {
    const m = mesh as MeshExportView;
    const positions = m._cpuPositions;
    if (!positions) {
        ctx.warn(`Mesh "${m.name}" has no retained CPU geometry; exporting its node without a mesh.`);
        return null;
    }
    const count = Math.floor(positions.length / 3);
    const indexSource = m._cpuGpuIndices ?? m._cpuIndices;
    if (count === 0 || indexSource?.length === 0) {
        return null;
    }
    const sourceMode = primitiveMode(m);
    const flip = needsWindingFlip(m._authoredSign, convert);
    // A reversed triangle list or strip with fewer than 3 indices has no triangle left to draw.
    if (flip && (sourceMode === 4 || sourceMode === 5) && (indexSource?.length ?? count) < 3) {
        return null;
    }

    const attributes: GltfAttributes = {};
    attributes.POSITION = vectorAccessor(ctx, positions, 3, count, convert ? "position-c" : "v", convert ? mirrorX : null, true);
    const normals = m._cpuNormals;
    if (normals && normals.length > 0 && !m._flatNormal && checkLength(ctx, m, normals, 3, count, "normals")) {
        attributes.NORMAL = vectorAccessor(ctx, normals, 3, count, convert ? "direction-c" : "unit", convert ? mirrorDirection : repairUnitLength, false);
    }
    const tangents = m._cpuTangents;
    if (tangents && tangents.length > 0) {
        if (checkLength(ctx, m, tangents, 4, count, "tangents")) {
            attributes.TANGENT = vectorAccessor(ctx, tangents, 4, count, convert ? "tangent-c" : "unit", convert ? mirrorTangent : repairUnitLength, false);
        }
    } else if (m._gpu?.tangentBuffer) {
        warnGpuOnly(ctx, m, "tangents");
    }
    const uvs = m._cpuUvs;
    if (uvs && uvs.length > 0 && checkLength(ctx, m, uvs, 2, count, "UVs")) {
        attributes.TEXCOORD_0 = vectorAccessor(ctx, uvs, 2, count, "v", null, false);
    }
    let uvState: UvState = "uv0";
    const uv2s = m._cpuUv2s;
    if (uv2s && uv2s.length > 0) {
        if (checkLength(ctx, m, uv2s, 2, count, "second UV set")) {
            attributes.TEXCOORD_1 = vectorAccessor(ctx, uv2s, 2, count, "v", null, false);
            uvState = "uv1";
        } else {
            uvState = "lost";
        }
    } else if (m._gpu?.uv2Buffer) {
        warnGpuOnly(ctx, m, "a second UV set");
        uvState = "lost";
    }
    const colors = m._cpuColors;
    if (colors && colors.length > 0) {
        if (checkLength(ctx, m, colors, 4, count, "vertex colors")) {
            attributes.COLOR_0 = vectorAccessor(ctx, colors, 4, count, "v", null, false);
        }
    } else if (m._gpu?.colorBuffer) {
        warnGpuOnly(ctx, m, "vertex colors");
    }
    if (m.skeleton) {
        ctx.warn(`Mesh "${m.name}" is skinned; skins are not exported, so it exports without skinning.`);
    }

    const primitive: GltfPrimitive = { attributes };
    const { index, mode } = indexAccessor(ctx, m, count, sourceMode, flip);
    if (index !== undefined) {
        primitive.indices = index;
    }
    if (mode !== 4) {
        primitive.mode = mode;
    }

    const morph = m.morphTargets;
    let weights: number[] | undefined;
    if (morph && morph.targets.length > 0) {
        if (morph.targets.some((t) => t.positions.length !== count * 3)) {
            ctx.warn(`Mesh "${m.name}" has morph targets whose length does not match its positions; exporting the mesh without them.`);
        } else {
            // glTF requires a base attribute for every morphed one, so NORMAL deltas need NORMAL.
            const withNormals = attributes.NORMAL !== undefined;
            primitive.targets = morph.targets.map((target) => {
                const t: GltfAttributes = {
                    POSITION: vectorAccessor(ctx, target.positions, 3, count, convert ? "position-c" : "v", convert ? mirrorX : null, true),
                };
                if (withNormals && target.normals && checkLength(ctx, m, target.normals, 3, count, "morph-target normals")) {
                    t.NORMAL = vectorAccessor(ctx, target.normals, 3, count, convert ? "position-c" : "v", convert ? mirrorX : null, false);
                }
                return t;
            });
            weights = morph.targets.map((_, i) => morph.weights[i] ?? 0);
        }
    }
    return { primitive, uvState, weights, vertexCount: count };
}

/** @internal A zero-filled TEXCOORD_0 accessor for `count` vertices: what Lite samples for a mesh
 *  without UVs (`uploadMeshToGPU` binds a zero-filled UV buffer), emitted when its material needs UV0. */
export function zeroUvAccessor(ctx: ExportContext, count: number): number {
    let index = ctx.zeroUvAccessors.get(count);
    if (index === undefined) {
        const bufferView = ctx.buffers.addBufferView(new Float32Array(count * 2), undefined, ARRAY_BUFFER);
        index = ctx.buffers.addAccessor({ bufferView, componentType: FLOAT, count, type: "VEC2" });
        ctx.zeroUvAccessors.set(count, index);
    }
    return index;
}

/** glTF numeric primitive mode for a mesh: `_topology` (1 points, 2 lines, 3 line strip, 4 triangle
 *  strip), else the glTF loader's `_primitive.topology`, else TRIANGLES. */
function primitiveMode(m: MeshExportView): number {
    switch (m._topology) {
        case 1:
            return 0;
        case 2:
            return 1;
        case 3:
            return 3;
        case 4:
            return 5;
    }
    switch (m._primitive?.topology) {
        case "point-list":
            return 0;
        case "line-list":
            return 1;
        case "line-strip":
            return 3;
        case "triangle-strip":
            return 5;
    }
    return 4;
}

function checkLength(ctx: ExportContext, m: Mesh, data: ArrayLike<number>, components: number, count: number, label: string): boolean {
    if (data.length === components * count) {
        return true;
    }
    ctx.warn(`Mesh "${m.name}" has ${label} whose length does not match its positions; exporting the mesh without them.`);
    return false;
}

function warnGpuOnly(ctx: ExportContext, m: Mesh, label: string): void {
    ctx.warn(`Mesh "${m.name}" has ${label} on the GPU only; exporting the mesh without them.`);
}

const ACCESSOR_TYPES: Readonly<Record<number, GltfAccessorType>> = { 2: "VEC2", 3: "VEC3", 4: "VEC4" };

/** A float vertex accessor over `count` elements of `components` floats each. `convert` builds the
 *  converted copy for converting passes; null emits the source bytes verbatim. */
function vectorAccessor(
    ctx: ExportContext,
    source: Float32Array,
    components: number,
    count: number,
    variant: string,
    convert: ((src: Float32Array, components: number) => Float32Array) | null,
    withBounds: boolean
): number {
    return cachedAccessor(ctx, source, `${variant}:${components}:${count}:${withBounds}`, () => {
        const data = convert ? convert(source, components) : source;
        const bufferView = ctx.buffers.addBufferView(data, undefined, ARRAY_BUFFER);
        const bounds = withBounds ? computeMinMax(data, components, count) : undefined;
        return ctx.buffers.addAccessor({ bufferView, componentType: FLOAT, count, type: ACCESSOR_TYPES[components]!, min: bounds?.min, max: bounds?.max });
    });
}

/** Pass-through normals and tangents: the source array itself when every xyz is unit length within
 *  glTF-Validator's tolerance (keeping round trips byte-stable), otherwise a copy with the
 *  offending non-zero vectors renormalized. */
function repairUnitLength(src: Float32Array, components: number): Float32Array {
    let out: Float32Array | null = null;
    for (let i = 0; i < src.length; i += components) {
        const len = Math.hypot(src[i]!, src[i + 1]!, src[i + 2]!);
        if (len > 0 && Math.abs(len - 1) > 0.0005) {
            out ??= src.slice();
            out[i] = src[i]! / len;
            out[i + 1] = src[i + 1]! / len;
            out[i + 2] = src[i + 2]! / len;
        }
    }
    return out ?? src;
}

/** Copy with component 0 of every element negated (positions and morph deltas). */
function mirrorX(src: Float32Array, components: number): Float32Array {
    const out = src.slice();
    for (let i = 0; i < out.length; i += components) {
        out[i] = -out[i]!;
    }
    return out;
}

/** Copy with X negated and xyz renormalized (normals). Zero-length vectors are left as they are. */
function mirrorDirection(src: Float32Array, components: number): Float32Array {
    const out = mirrorX(src, components);
    for (let i = 0; i < out.length; i += components) {
        const len = Math.hypot(out[i]!, out[i + 1]!, out[i + 2]!);
        if (len > 0) {
            out[i] = out[i]! / len;
            out[i + 1] = out[i + 1]! / len;
            out[i + 2] = out[i + 2]! / len;
        }
    }
    return out;
}

/** Copy of tangents for a converting pass: xyz as directions, and w negated, because a mirror
 *  reverses the bitangent's handedness (`cross(C·n, C·t) = −C·cross(n, t)` for the reflection C). */
function mirrorTangent(src: Float32Array, components: number): Float32Array {
    const out = mirrorDirection(src, components);
    for (let i = 3; i < out.length; i += 4) {
        out[i] = -out[i]!;
    }
    return out;
}

/** The index accessor and glTF mode for a mesh. Winding reversal (`flip`) applies to triangle
 *  lists by swapping each triangle's last two indices; a triangle strip that needs it is expanded
 *  to a reversed triangle list. Non-indexed meshes get synthesized indices only when reversed. */
function indexAccessor(ctx: ExportContext, m: Mesh, vertexCount: number, mode: number, flip: boolean): { index?: number; mode: number } {
    const source: Uint16Array | Uint32Array | undefined = m._cpuGpuIndices ?? m._cpuIndices;
    const strip = flip && mode === 5;
    if (!(flip && (mode === 4 || mode === 5)) && !source) {
        return { mode };
    }
    // Non-indexed geometry indexes its vertices in order.
    const key: ArrayBufferView = source ?? m._cpuPositions!;
    const variant = strip ? "indices-strip-reversed" : flip && mode === 4 ? "indices-reversed" : "indices";
    const index = cachedAccessor(ctx, key, source ? variant : `${variant}-synthesized`, () => {
        const list: ArrayLike<number> = source ?? sequence(vertexCount);
        let out: number[] | Uint16Array | Uint32Array;
        if (strip) {
            // Strip triangle i is (s[i], s[i+1], s[i+2]) for even i and (s[i+1], s[i], s[i+2]) for odd
            // i; reversed, each becomes (a, c, b).
            const triangles = Math.max(list.length - 2, 0);
            out = new Array<number>(triangles * 3);
            for (let i = 0; i < triangles; i++) {
                const a = i & 1 ? list[i + 1]! : list[i]!;
                const b = i & 1 ? list[i]! : list[i + 1]!;
                out[i * 3] = a;
                out[i * 3 + 1] = list[i + 2]!;
                out[i * 3 + 2] = b;
            }
        } else if (flip && mode === 4) {
            const triangles = Math.floor(list.length / 3);
            out = new Array<number>(triangles * 3);
            for (let t = 0; t < triangles; t++) {
                out[t * 3] = list[t * 3]!;
                out[t * 3 + 1] = list[t * 3 + 2]!;
                out[t * 3 + 2] = list[t * 3 + 1]!;
            }
        } else {
            out = source!;
        }
        return addIndexAccessor(ctx, toIndexArray(out, m._cpuGpuIndices));
    });
    return { index, mode: strip ? 4 : mode };
}

/** Pack indices at their glTF width. Retained 32-bit indices (`_cpuGpuIndices`) stay 32-bit. All
 *  others use UNSIGNED_SHORT when every value is below 65535 — glTF reserves 65535 as the 16-bit
 *  primitive-restart value — and UNSIGNED_INT otherwise. */
function toIndexArray(values: ArrayLike<number>, retained: Uint16Array | Uint32Array | undefined): Uint16Array | Uint32Array {
    if (!(retained instanceof Uint32Array)) {
        let max = 0;
        for (let i = 0; i < values.length; i++) {
            if (values[i]! > max) {
                max = values[i]!;
            }
        }
        if (max < 65535) {
            return values instanceof Uint16Array ? values : Uint16Array.from(values);
        }
    }
    return values instanceof Uint32Array ? values : Uint32Array.from(values);
}

function sequence(count: number): number[] {
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++) {
        out[i] = i;
    }
    return out;
}

function addIndexAccessor(ctx: ExportContext, data: Uint16Array | Uint32Array): number {
    const bufferView = ctx.buffers.addBufferView(data, undefined, ELEMENT_ARRAY_BUFFER);
    return ctx.buffers.addAccessor({ bufferView, componentType: data instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT, count: data.length, type: "SCALAR" });
}
