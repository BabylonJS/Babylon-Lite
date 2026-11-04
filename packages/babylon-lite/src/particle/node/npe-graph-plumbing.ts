import type { ParticleGraph } from "./npe-types.js";

/**
 * Normalize supported graph plumbing in a graph returned by `parseNodeParticleSource`.
 *
 * Directly parsed graphs containing supported plumbing classes require this step before they are passed to any node-particle builder. Graphs
 * without a candidate class resolve to the same graph object. Validation failures reject the returned Promise.
 */
export async function normalizeNodeParticleGraph(graph: ParticleGraph): Promise<ParticleGraph> {
    if (graph._isGraphPlumbingNormalized) {
        return graph;
    }
    for (const block of graph.blocks.values()) {
        if (
            block.className === "ParticleTeleportOutBlock" ||
            block.className === "ParticleLocalVariableBlock" ||
            block.className === "ParticleElbowBlock" ||
            block.className === "ParticleDebugBlock"
        ) {
            return (await import("./npe-graph-plumbing-runtime.js")).normalizeNodeParticleGraphRuntime(graph);
        }
    }
    return graph;
}
