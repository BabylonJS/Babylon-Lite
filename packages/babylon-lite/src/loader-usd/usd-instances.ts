import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { UsdContext } from "./usd-context.js";
import { UsdOp, usdField, usdString } from "./usd-protocol.js";
import { createUsdDraw } from "./usd-meshes.js";

/** @internal Preserve editable placements while sharing CPU/GPU geometry with their prototype. */
export async function apply(context: UsdContext): Promise<void> {
    // Iterate native source records, never newly created placements.
    for (const record of context.records) {
        if (record.op !== UsdOp.Instance) {
            continue;
        }
        const sources = context.sources.get(usdField(record, 0));
        if (!sources) {
            throw new Error("USD instance references a missing source");
        }
        const sourceId = usdField(record, 0);
        if (context.thinInstanceSources.has(sourceId)) {
            throw new Error(`USD mesh ${sourceId} cannot mix classic and thin instances`);
        }
        context.classicInstanceSources.add(sourceId);
        const name = usdString(context.data, usdField(record, 2), usdField(record, 3));
        for (const source of sources) {
            createUsdDraw(context, source.geometry, source.mesh.material as PbrMaterialProps, name, usdField(record, 1), source.skeletonId, source);
        }
    }
}
