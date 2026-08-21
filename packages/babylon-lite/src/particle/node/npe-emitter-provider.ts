import type { EngineContext } from "../../engine/engine.js";
import type { Mat4 } from "../../math/types.js";
import type { SceneContext } from "../../scene/scene.js";
import { buildNodeParticleSet } from "./npe-build.js";
import type { BuildNodeParticleOptions, NodeParticleSet } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";

/** Pure-state source sampled for the emitter world transform. */
export type NodeParticleEmitterProvider = () => Mat4;

/** Enable a live emitter provider on an already-built NPE set. Mutates and returns the same set. */
export async function enableNodeParticleEmitterProvider(set: NodeParticleSet, provider: NodeParticleEmitterProvider): Promise<NodeParticleSet> {
    return (await import("./npe-live-emitter.js")).enableNodeParticleEmitterProviderRuntime(set, provider);
}

/** Build an NPE set, then enable a live emitter provider on it. */
export async function buildNodeParticleSetWithEmitterProvider(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    provider: NodeParticleEmitterProvider,
    options: BuildNodeParticleOptions = {}
): Promise<NodeParticleSet> {
    return enableNodeParticleEmitterProvider(await buildNodeParticleSet(engine, scene, graph, options), provider);
}
