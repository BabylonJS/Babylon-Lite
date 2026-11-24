// Runtime construction: resolves block defs through the lazy block registry.
// Kept out of runtime.ts because every block module statically imports runtime.ts
// (getDataValue, activateSignal, ...). If runtime.ts imported the registry, each
// lazily-loaded block would statically reach the module that lazy-loads it, and
// Rolldown (Vite 8) then emits every block chunk even for apps that never use
// flow graphs. Enforced by tests/lite/build/lazy-import-cycles.test.ts.

import type { FgBlockDef } from "./block-def.js";
import type { FgEnv, FgWiring } from "./context.js";
import { createFgEventBus } from "./event-bus.js";
import { getBlockDef } from "./block-registry.js";
import { createFgContext, type FgRuntime } from "./runtime.js";
import type { FgGraph } from "./types.js";

/** Build the resolved env: await every block def the graph needs (registry or
 *  wiring override), then attach accessors/animations/caps/bus.
 *
 *  Unknown op policy: the registry returns `null` for an unknown type and this
 *  loader FAILS LOUDLY (throws with the offending types) so a `KHR_interactivity`
 *  asset can't silently render a broken interaction. */
export async function createFgEnv(graph: FgGraph, wiring: FgWiring = {}): Promise<FgEnv> {
    const defs: Record<string, FgBlockDef> = {};
    const unsupported: string[] = [];

    for (const block of graph.blocks) {
        if (defs[block.type]) {
            continue;
        }
        const override = wiring.defs?.[block.type];
        if (override) {
            defs[block.type] = override;
            continue;
        }
        const loader = getBlockDef(block.type);
        if (!loader) {
            if (!unsupported.includes(block.type)) {
                unsupported.push(block.type);
            }
            continue;
        }
        defs[block.type] = await loader();
    }

    if (unsupported.length > 0) {
        throw new Error(`flow-graph: unsupported block type(s): ${unsupported.join(", ")}`);
    }

    return {
        graph,
        defs,
        accessors: wiring.accessors ?? {},
        resolveAccessor: wiring.resolveAccessor,
        animations: wiring.animations ?? [],
        caps: wiring.caps ?? {},
        events: wiring.events ?? createFgEventBus(),
        _assetScope: wiring._assetScope,
    };
}

/** Assemble a runtime from a graph + wiring (creates context + env). */
export async function createFgRuntime(graph: FgGraph, wiring: FgWiring = {}, opts?: { rightHanded?: boolean }): Promise<FgRuntime> {
    const env = await createFgEnv(graph, wiring);
    const context = createFgContext(graph, opts);
    return { graph, context, env, started: false, _unsub: [] };
}
