import type { ParticleGraph } from "./npe-types.js";

/**
 * Normalize supported graph plumbing in a graph returned by `parseNodeParticleSource`.
 *
 * Directly parsed graphs containing Teleport routes require this step before they are passed to any node-particle builder. Graphs without a
 * `ParticleTeleportOutBlock` resolve to the same graph object. Validation failures reject the returned Promise.
 */
export async function normalizeNodeParticleGraph(graph: ParticleGraph): Promise<ParticleGraph> {
    if (graph._isGraphPlumbingNormalized) {
        return graph;
    }
    for (const block of graph.blocks.values()) {
        if (block.className === "ParticleTeleportOutBlock") {
            return (await import("./npe-graph-plumbing-runtime.js")).normalizeNodeParticleGraphRuntime(graph);
        }
    }
    return graph;
}
