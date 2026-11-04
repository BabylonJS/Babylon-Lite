/** Material export: family dispatch, one glTF material per (material, UV state), and the final
 *  cleanup of empty `pbrMetallicRoughness` objects. The families live in `export-material-pbr.ts` and
 *  `export-material-standard.ts`. */

import type { Material } from "../material/material.js";
import { getMaterialFamily } from "../material/material-family.js";
import { getMaterialSource } from "../material/material-view.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import type { ExportContext, UvState } from "./export-context.js";
import { snapshotExtras } from "./export-context.js";
import type { GltfMaterial } from "./export-gltf-types.js";
import { exportPbrMaterial, pbrSelectsUv1 } from "./export-material-pbr.js";
import { exportStandardMaterial, standardSelectsUv1 } from "./export-material-standard.js";

/** @internal Return the glTF material index for a mesh's material in the mesh's UV state, emitting the
 *  material on first use. Returns undefined, with a warning, for families glTF cannot express. */
export function exportMaterial(ctx: ExportContext, material: Material | null | undefined, uvState: UvState): number | undefined {
    if (!material) {
        return undefined;
    }
    const source = getMaterialSource(material);
    const family = getMaterialFamily(source);
    if (family !== "pbr" && family !== "standard") {
        ctx.warn(`Material "${source.name ?? ""}" of family "${family ?? "unknown"}" is not mapped to glTF; exporting the primitive without a material.`);
        return undefined;
    }
    // A material none of whose slots selects UV1 exports identically in every UV state.
    const selectsUv1 = family === "pbr" ? pbrSelectsUv1(source as PbrMaterialProps) : standardSelectsUv1(source as StandardMaterialProps);
    const key: UvState = selectsUv1 ? uvState : "uv0";
    let byState = ctx.materialIndex.get(source);
    if (!byState) {
        byState = new Map();
        ctx.materialIndex.set(source, byState);
    }
    let index = byState.get(key);
    if (index === undefined) {
        const out: GltfMaterial = {};
        if (source.name) {
            out.name = source.name;
        }
        index = ctx.doc.materials.push(out) - 1;
        byState.set(key, index);
        const firstSlot = ctx.slots.length;
        if (family === "pbr") {
            exportPbrMaterial(ctx, source as PbrMaterialProps, out, key);
        } else {
            exportStandardMaterial(ctx, source as StandardMaterialProps, out, key);
        }
        if (ctx.slots.slice(firstSlot).some((slot) => slot.mapping.texCoord === 0)) {
            ctx.materialsUsingUv0.add(index);
        }
        const extras = snapshotExtras(ctx, source.metadata?.gltf?.extras, source.name);
        if (extras !== undefined) {
            out.extras = extras;
        }
    }
    return index;
}

/** @internal Remove `pbrMetallicRoughness` objects that ended up with no members (after every slot,
 *  fold and `afterResolve` callback ran). */
export function finalizeMaterials(ctx: ExportContext): void {
    for (const material of ctx.doc.materials) {
        const pmr = material.pbrMetallicRoughness;
        if (pmr && Object.values(pmr).every((v) => v === undefined)) {
            delete material.pbrMetallicRoughness;
        }
    }
}
