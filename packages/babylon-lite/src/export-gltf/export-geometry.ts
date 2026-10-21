/** Geometry export: one glTF primitive per Lite mesh, from the retained CPU arrays. */

import type { Mesh } from "../mesh/mesh.js";
import type { ExportContext, UvState } from "./export-context.js";
import { computeMinMax } from "./export-buffers.js";
import type { GltfAccessorType, GltfAttributes, GltfBufferViewTarget, GltfPrimitive } from "./export-gltf-types.js";
import { needsWindingFlip } from "./export-handedness.js";

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER: GltfBufferViewTarget = 34962;
const ELEMENT_ARRAY_BUFFER: GltfBufferViewTarget = 34963;

/** @internal One exported primitive, before its material is attached. */
export interface ExportedPrimitive {
    readonly primitive: GltfPrimitive;
    /** How the mesh's second UV set exports; selects the material variant. */
    readonly uvState: UvState;
    /** Current morph weights, when the mesh has morph targets. */
    readonly weights?: ArrayLike<number>;
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
    if (count === 0) {
        return null;
    }
    const mode = primitiveMode(m);
    const flip = needsWindingFlip(m._authoredSign, convert);
    if (flip && mode === 5) {
        throw new Error("Triangle strip winding reversal is not implemented");
    }
    const reverse = flip && mode === 4;

    const attributes: GltfAttributes = {};
    attributes.POSITION = vectorAccessor(ctx, positions, 3, count, convert ? "position-c" : "v", convert ? mirrorX : null, true);
    const normals = m._cpuNormals;
    if (normals && !m._flatNormal && checkLength(ctx, m, normals, 3, count, "normals")) {
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
    const indices = indexAccessor(ctx, m, count, reverse);
    if (indices === null) {
        return null;
    }
    if (indices !== undefined) {
        primitive.indices = indices;
    }
    if (mode !== 4) {
        primitive.mode = mode;
    }

    const morph = m.morphTargets;
    let weights: ArrayLike<number> | undefined;
    if (morph && morph.targets.length > 0) {
        const targets: GltfAttributes[] = [];
        for (const target of morph.targets) {
            const t: GltfAttributes = {};
            if (target.positions.length === count * 3) {
                t.POSITION = vectorAccessor(ctx, target.positions, 3, count, convert ? "position-c" : "v", convert ? mirrorX : null, true);
            }
            if (target.normals && target.normals.length === count * 3) {
                t.NORMAL = vectorAccessor(ctx, target.normals, 3, count, convert ? "position-c" : "v", convert ? mirrorX : null, false);
            }
            targets.push(t);
        }
        primitive.targets = targets;
        weights = morph.weights;
    }
    return { primitive, uvState, weights };
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

/** Return the cached accessor for (`source`, `variant`), building it on first use. */
function cachedAccessor(ctx: ExportContext, source: ArrayBufferView, variant: string, build: () => number): number {
    let byVariant = ctx.accessorIndex.get(source);
    if (!byVariant) {
        byVariant = new Map();
        ctx.accessorIndex.set(source, byVariant);
    }
    let index = byVariant.get(variant);
    if (index === undefined) {
        index = build();
        byVariant.set(variant, index);
    }
    return index;
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
    return cachedAccessor(ctx, source, variant, () => {
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

/** The index accessor for a mesh: undefined for a non-indexed primitive that needs no reversal,
 *  null when the mesh has an empty index list (nothing to draw). */
function indexAccessor(ctx: ExportContext, m: Mesh, vertexCount: number, reverse: boolean): number | undefined | null {
    const source: Uint16Array | Uint32Array | undefined = m._cpuGpuIndices ?? m._cpuIndices;
    if (!source) {
        if (!reverse) {
            return undefined;
        }
        // Non-indexed and needs reversal: synthesize the flipped sequence (0, 2, 1, 3, 5, 4, …).
        const positions = m._cpuPositions!;
        return cachedAccessor(ctx, positions, "synthesized-indices", () => {
            const triangles = Math.floor(vertexCount / 3);
            const out = vertexCount <= 65535 ? new Uint16Array(triangles * 3) : new Uint32Array(triangles * 3);
            for (let t = 0; t < triangles; t++) {
                out[t * 3] = t * 3;
                out[t * 3 + 1] = t * 3 + 2;
                out[t * 3 + 2] = t * 3 + 1;
            }
            return addIndexAccessor(ctx, out);
        });
    }
    if (source.length === 0) {
        return null;
    }
    const retainedWidth = m._cpuGpuIndices !== undefined;
    return cachedAccessor(ctx, source, reverse ? "indices-reversed" : "indices", () => {
        let data: Uint16Array | Uint32Array = source;
        if (!retainedWidth && source instanceof Uint32Array && maxValue(source) < 65535) {
            data = Uint16Array.from(source);
        }
        if (reverse) {
            data = data === source ? data.slice() : data;
            const triangles = Math.floor(data.length / 3);
            for (let t = 0; t < triangles; t++) {
                const i1 = data[t * 3 + 1]!;
                data[t * 3 + 1] = data[t * 3 + 2]!;
                data[t * 3 + 2] = i1;
            }
        }
        return addIndexAccessor(ctx, data);
    });
}

function addIndexAccessor(ctx: ExportContext, data: Uint16Array | Uint32Array): number {
    const bufferView = ctx.buffers.addBufferView(data, undefined, ELEMENT_ARRAY_BUFFER);
    return ctx.buffers.addAccessor({ bufferView, componentType: data instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT, count: data.length, type: "SCALAR" });
}

function maxValue(data: Uint32Array): number {
    let max = 0;
    for (let i = 0; i < data.length; i++) {
        if (data[i]! > max) {
            max = data[i]!;
        }
    }
    return max;
}
