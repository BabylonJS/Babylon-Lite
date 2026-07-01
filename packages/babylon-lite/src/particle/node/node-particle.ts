import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Vec3 } from "../../math/types.js";
import { parseNodeParticleSource } from "./npe-parser.js";
import { buildNodeParticleSet } from "./npe-build.js";
import type { NodeParticleSet } from "./npe-build.js";

/** Options for {@link parseNodeParticleSetFromSnippet}. */
export interface ParseNodeParticleOptions {
    /** Inline graph JSON (string or parsed object); bypasses the network. */
    json?: string | object;
    /** Override the snippet server origin. */
    snippetServer?: string;
    /** Emitter world position applied to every system (pure-translation emitter). */
    emitter?: Vec3;
    /** Base URL used to resolve relative texture URLs in the graph (mirrors BJS texture-base resolution). */
    textureBaseUrl?: string;
}

/**
 * Parse a Node Particle Editor graph (from the Babylon snippet server or inline JSON) and build its runtime
 * particle systems. The analogue of `parseNodeMaterialFromSnippet` for particles.
 *
 * @param engine - The engine (used for texture loads).
 * @param scene - The hosting scene (carried in the per-particle evaluation context).
 * @param snippetId - Snippet id (e.g. `#W5054F`); ignored when `options.json` is provided.
 * @param options - Inline JSON, snippet server override, and emitter position.
 * @returns The built {@link NodeParticleSet}.
 */
export async function parseNodeParticleSetFromSnippet(
    engine: EngineContext,
    scene: SceneContext,
    snippetId: string,
    options: ParseNodeParticleOptions = {}
): Promise<NodeParticleSet> {
    let source: unknown;
    if (options.json !== undefined) {
        source = typeof options.json === "string" ? JSON.parse(options.json) : options.json;
    } else {
        source = await (await import("./npe-snippet.js")).fetchNodeParticleSnippet(snippetId, options.snippetServer);
    }

    const graph = parseNodeParticleSource(source);
    return await buildNodeParticleSet(engine, scene, graph, { emitter: options.emitter, textureBaseUrl: options.textureBaseUrl });
}
