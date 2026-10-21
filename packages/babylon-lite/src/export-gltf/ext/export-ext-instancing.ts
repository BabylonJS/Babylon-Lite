/** EXT_mesh_gpu_instancing: thin instances → per-node instance TRS attributes. */

import type { Mat4 } from "../../math/types.js";
import { decomposeMat4 } from "../../math/decompose-mat4.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { ExportContext } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfAttributes, GltfNode } from "../export-gltf-types.js";
import { convertRotation, EXPORT_EPSILON } from "../export-handedness.js";

const EXT = "EXT_mesh_gpu_instancing";
const FLOAT = 5126;

/** @internal Attach `EXT_mesh_gpu_instancing` to `node` for a mesh with active thin instances.
 *  Instance matrices are node-local in Lite (`world × instanceMatrix`), as the extension expects.
 *  Each attribute is emitted only when some instance deviates from its identity value. Recorded in
 *  `extensionsUsed` only: readers without the extension still draw one copy. */
export function writeInstancing(ctx: ExportContext, node: GltfNode, mesh: Mesh, convert: boolean): void {
    const thin = mesh.thinInstances;
    if (!thin || thin.count <= 0) {
        return;
    }
    const count = thin.count;
    const translations = new Float32Array(count * 3);
    const rotations = new Float32Array(count * 4);
    const scales = new Float32Array(count * 3);
    let moved = false;
    let rotated = false;
    let scaled = false;
    for (let i = 0; i < count; i++) {
        const { translation: t, rotation: r, scale: s } = decomposeMat4(thin.matrices.subarray(i * 16, i * 16 + 16) as unknown as Mat4);
        const q = convert ? convertRotation(r.x, r.y, r.z, r.w) : [r.x, r.y, r.z, r.w];
        translations.set([convert ? -t.x : t.x, t.y, t.z], i * 3);
        rotations.set(q, i * 4);
        scales.set([s.x, s.y, s.z], i * 3);
        moved ||= Math.abs(t.x) > EXPORT_EPSILON || Math.abs(t.y) > EXPORT_EPSILON || Math.abs(t.z) > EXPORT_EPSILON;
        rotated ||= Math.abs(q[0]!) > EXPORT_EPSILON || Math.abs(q[1]!) > EXPORT_EPSILON || Math.abs(q[2]!) > EXPORT_EPSILON;
        scaled ||= Math.abs(s.x - 1) > EXPORT_EPSILON || Math.abs(s.y - 1) > EXPORT_EPSILON || Math.abs(s.z - 1) > EXPORT_EPSILON;
    }

    const colors = thin.colors && thin.colors.length >= count * 4 ? thin.colors : null;
    const attributes: GltfAttributes = {};
    // The extension requires at least one attribute; all-identity instances keep TRANSLATION.
    if (moved || !(rotated || scaled || colors)) {
        attributes.TRANSLATION = addFloatAccessor(ctx, translations, count, "VEC3");
    }
    if (rotated) {
        attributes.ROTATION = addFloatAccessor(ctx, rotations, count, "VEC4");
    }
    if (scaled) {
        attributes.SCALE = addFloatAccessor(ctx, scales, count, "VEC3");
    }
    if (colors) {
        const rgb = new Float32Array(count * 3);
        let translucent = false;
        for (let i = 0; i < count; i++) {
            rgb[i * 3] = colors[i * 4]!;
            rgb[i * 3 + 1] = colors[i * 4 + 1]!;
            rgb[i * 3 + 2] = colors[i * 4 + 2]!;
            translucent ||= colors[i * 4 + 3]! < 1;
        }
        if (translucent) {
            ctx.warn(`Instance color alpha of mesh "${mesh.name}" is not represented in _COLOR_0; exporting RGB.`);
        }
        attributes._COLOR_0 = addFloatAccessor(ctx, rgb, count, "VEC3");
    }
    attachExtension(ctx, node, EXT, { attributes });
}

function addFloatAccessor(ctx: ExportContext, data: Float32Array, count: number, type: "VEC3" | "VEC4"): number {
    const bufferView = ctx.buffers.addBufferView(data);
    return ctx.buffers.addAccessor({ bufferView, componentType: FLOAT, count, type });
}
