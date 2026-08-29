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
    let plumbing = false;
    for (const block of graph.blocks.values()) {
        const className = block.className;
        plumbing ||= /^Particle(TeleportOut|LocalVariable|Elbow|Debug)Block$/.test(className);
    }
    return plumbing ? (await import("./npe-graph-plumbing-runtime.js")).normalizeNodeParticleGraphRuntime(graph) : graph;
}
