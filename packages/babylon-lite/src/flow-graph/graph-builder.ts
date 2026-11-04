// Public FgGraph builder — construct a runnable graph imperatively (WITHOUT a
// glTF asset). Resolves each block's socket shape from the registry (or a `defs`
// override) and wires edges, producing the SAME pure-data `FgGraph` the glTF
// parser emits, so `createFgRuntime` / `addFlowGraph` consume it unchanged.
//
// Data-first by design (GUIDANCE §4b′): you describe nodes + edges as plain
// records; behaviour stays in the block defs. Async because block defs are
// lazily imported by the tree-shakable registry.

import type { FgBlock, FgGraph, FgValue, FgType } from "./types.js";
import type { FgBlockDef } from "./block-def.js";
import { getBlockDef } from "./block-registry.js";

/** One node in a graph spec. `id` must be unique within the graph. */
export interface FgNodeSpec {
    readonly id: string;
    /** `FgBlockType` value or a `"module/Name"` custom identifier. */
    readonly type: string;
    /** Block configuration passed to `def.build(config)`. */
    readonly config?: Record<string, unknown>;
    /** Signal OUTPUT socket name → wired targets (consumer id + input signal). */
    readonly signalTargets?: Record<string, { blockId: string; socket: string }[]>;
    /** Data INPUT socket name → wired source (producer id + output socket). */
    readonly dataSources?: Record<string, { blockId: string; socket: string }>;
    /** Data INPUT socket name → literal fallback used when the input is unwired. */
    readonly dataDefaults?: Record<string, FgValue>;
}

/** Declared graph variable: initial value + rich type. */
export interface FgVariableSpec {
    readonly type: FgType;
    readonly value: FgValue;
}

/** Build a runnable `FgGraph` from node specs. Each block's shape is resolved
 *  from its def (registry, or an override in `opts.defs`); edges are wired by id
 *  + socket name. Throws on an unknown block type so authoring errors fail loudly.
 */
export async function buildFgGraph(specs: readonly FgNodeSpec[], opts: { variables?: Record<string, FgVariableSpec>; defs?: Record<string, FgBlockDef> } = {}): Promise<FgGraph> {
    const defs = opts.defs ?? {};
    const blocks: FgBlock[] = [];

    for (const spec of specs) {
        const def = defs[spec.type] ?? (await getBlockDef(spec.type)?.());
        if (!def) {
            throw new Error(`buildFgGraph: unknown block type "${spec.type}"`);
        }
        const shape = def.build(spec.config);
        blocks.push({
            id: spec.id,
            type: spec.type,
            config: spec.config,
            dataIn: (shape.dataIn ?? []).map((d) => ({
                name: d.name,
                type: d.type,
                source: spec.dataSources?.[d.name],
                defaultValue: spec.dataDefaults?.[d.name] ?? d.defaultValue,
            })),
            dataOut: shape.dataOut ?? [],
            signalIn: shape.signalIn ?? [],
            signalOut: (shape.signalOut ?? []).map((s) => ({ name: s.name, targets: spec.signalTargets?.[s.name] ?? [] })),
            event: shape.event,
        });
    }

    const byId: Record<string, number> = {};
    blocks.forEach((b, i) => (byId[b.id] = i));
    return { blocks, byId, variables: opts.variables ?? {} };
}
