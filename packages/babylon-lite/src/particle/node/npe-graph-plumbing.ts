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
    let phase4 = false;
    for (const block of graph.blocks.values()) {
        const className = block.className;
        plumbing ||= /^Particle(TeleportOut|LocalVariable|Elbow|Debug)Block$/.test(className);
        phase4 ||= (className === "ParticleInputBlock" && block.serialized.type === 0x0001) || /^Particle(FloatToInt|NumberMath|Clamp|Step)Block$/.test(className);
    }
    const normalized = plumbing ? await (await import("./npe-graph-plumbing-runtime.js")).normalizeNodeParticleGraphRuntime(graph) : graph;
    if (phase4) {
        (await import("./npe-phase4-values.js")).enablePhase4ValueGraph(normalized);
    }
    return normalized;
}
