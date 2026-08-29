import type { ParticleGraph, ParsedParticleBlock } from "./npe-types.js";
import { resolveParticleValueTypes } from "./blocks/particle-value-type.js";
import { loadNpeBlockEvaluator } from "./npe-registry.js";

async function loadPhase4ValueBlockEvaluator(block: ParsedParticleBlock) {
    return (await import("./npe-registry-phase4-values.js")).loadPhase4ValueBlockEvaluator(block).then((evaluator) => evaluator ?? loadNpeBlockEvaluator(block.className));
}

/** Enable propagated value types and Phase 4 evaluators for one graph. */
export function enablePhase4ValueGraph(graph: ParticleGraph): void {
    resolveParticleValueTypes(graph.blocks);
    graph._loadEvaluator = loadPhase4ValueBlockEvaluator;
}
