import { enableThinInstanceWorldBounds } from "../mesh/enable-thin-instance-world-bounds.js";
import { setThinInstances } from "../mesh/thin-instance.js";
import type { UsdContext } from "./usd-context.js";
import { UsdOp, usdField, usdFloats } from "./usd-protocol.js";

/** @internal Attach each point-instancer matrix slab to its prototype draws. */
export function apply(context: UsdContext): void {
    for (const record of context.records) {
        if (record.op !== UsdOp.ThinInstances) {
            continue;
        }
        const sourceId = usdField(record, 0);
        const sources = context.sources.get(sourceId);
        if (!sources) {
            throw new Error(`USD thin instances reference missing source ${sourceId}`);
        }
        if (context.classicInstanceSources.has(sourceId) || context.thinInstanceSources.has(sourceId)) {
            throw new Error(`USD mesh ${sourceId} has duplicate or mixed instances`);
        }
        const count = usdField(record, 2);
        // Gf row-major row-vector bytes are the equivalent Lite column-major
        // column-vector sequence, including translation at indices 12-14.
        const matrices = usdFloats(context.data, usdField(record, 1), count * 16);
        if (!matrices.every(Number.isFinite)) {
            throw new Error(`USD thin instances for mesh ${sourceId} contain a non-finite transform`);
        }
        for (const source of sources) {
            setThinInstances(source.mesh, matrices, count);
            enableThinInstanceWorldBounds(source.mesh);
        }
        context.thinInstanceSources.add(sourceId);
    }
}
