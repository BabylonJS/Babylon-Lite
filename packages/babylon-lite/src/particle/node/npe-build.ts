import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Vec3 } from "../../math/types.js";
import type { ParticleSystem } from "../particle-system.js";
import type { ParticleGraph, NpeGetter, NpeBuildContext, NpeBuildState, ParticleBlockEvaluator, ParticleValue, ParsedParticleInput } from "./npe-types.js";
import { loadParticleBlockEvaluator } from "./npe-registry.js";

/** Parse a literal value serialized directly on an unconnected input. Returns `undefined` if absent. */
function parseInputLiteral(input: ParsedParticleInput): ParticleValue | undefined {
    const value = input.value;
    if (value === undefined || value === null) {
        return undefined;
    }
    if (input.valueType === "number" || typeof value === "number") {
        return typeof value === "number" ? value : undefined;
    }
    if (Array.isArray(value)) {
        const array = value as number[];
        switch (input.valueType) {
            case "BABYLON.Vector2":
                return { x: array[0] ?? 0, y: array[1] ?? 0 };
            case "BABYLON.Vector3":
                return { x: array[0] ?? 0, y: array[1] ?? 0, z: array[2] ?? 0 };
            case "BABYLON.Color4":
                return { r: array[0] ?? 0, g: array[1] ?? 0, b: array[2] ?? 0, a: array[3] ?? 1 };
            default:
                return undefined;
        }
    }
    return undefined;
}

/** A built node-particle set — plain state (the analogue of Babylon.js `ParticleSystemSet`). */
export interface NodeParticleSet {
    /** The built particle systems (one per `SystemBlock` root). */
    readonly systems: ParticleSystem[];
    /** @internal Parsed graph, retained for debugging. */
    _graph: ParticleGraph;
}

/** Options for {@link buildNodeParticleSet}. */
export interface BuildNodeParticleOptions {
    /** Emitter world position applied to every system (pure-translation emitter). Defaults to the origin. */
    emitter?: Vec3;
    /** Base URL used to resolve relative texture URLs in the graph. */
    textureBaseUrl?: string;
}

/**
 * Build the runtime particle systems from a parsed graph.
 *
 * All block evaluators are dynamically imported up-front (so a scene bundles only the block classes its
 * graph references), then each `SystemBlock` root is built via a post-order walk of its `particle` input
 * chain — the same order Babylon.js builds in, which is what keeps creation-time random draws aligned.
 */
export async function buildNodeParticleSet(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options: BuildNodeParticleOptions = {}): Promise<NodeParticleSet> {
    // Pre-load the evaluator for every distinct block class in the graph.
    const classNames = new Set<string>();
    for (const block of graph.blocks.values()) {
        classNames.add(block.className);
    }
    const evaluators = new Map<string, ParticleBlockEvaluator>();
    await Promise.all(
        [...classNames].map(async (className) => {
            evaluators.set(className, await loadParticleBlockEvaluator(className));
        })
    );

    const systems: ParticleSystem[] = [];
    const buildPromises: Promise<void>[] = [];

    for (const systemId of graph.systemBlockIds) {
        const systemBlock = graph.blocks.get(systemId);
        if (!systemBlock) {
            continue;
        }

        const capacity = typeof systemBlock.serialized.capacity === "number" ? systemBlock.serialized.capacity : 1000;

        const state: NpeBuildState = {
            system: null,
            particle: null,
            capacity,
            emitter: options.emitter ?? { x: 0, y: 0, z: 0 },
            scene,
            textureBaseUrl: options.textureBaseUrl,
        };

        const outputs = new Map<string, NpeGetter>();
        const built = new Set<number>();

        const ctx: NpeBuildContext = {
            state,
            engine,
            input(block, name, fallback) {
                const input = block.inputs.find((i) => i.name === name);
                if (input && input.targetBlockId != null && input.targetConnectionName != null) {
                    const getter = outputs.get(`${input.targetBlockId}:${input.targetConnectionName}`);
                    if (getter) {
                        return getter;
                    }
                }
                if (input) {
                    const literal = parseInputLiteral(input);
                    if (literal !== undefined) {
                        return () => literal;
                    }
                }
                return fallback ?? (() => null);
            },
            isConnected(block, name) {
                const input = block.inputs.find((i) => i.name === name);
                return !!(input && input.targetBlockId != null);
            },
            setOutput(blockId, name, getter) {
                outputs.set(`${blockId}:${name}`, getter);
            },
            addBuildPromise(promise) {
                buildPromises.push(promise);
            },
        };

        const buildBlock = (blockId: number): void => {
            if (built.has(blockId)) {
                return;
            }
            built.add(blockId);

            const block = graph.blocks.get(blockId);
            if (!block) {
                return;
            }

            // Build upstream blocks first (post-order), so their outputs are available.
            for (const input of block.inputs) {
                if (input.targetBlockId != null) {
                    buildBlock(input.targetBlockId);
                }
            }

            const evaluator = evaluators.get(block.className);
            if (!evaluator) {
                throw new Error(`NodeParticle: no evaluator for block class "${block.className}"`);
            }
            evaluator.build(block, ctx);
        };

        buildBlock(systemId);

        if (state.system) {
            systems.push(state.system);
        }
    }

    await Promise.all(buildPromises);

    // Bind particle textures now that async asset loads have settled.
    for (const system of systems) {
        if (system._resolveTexture) {
            system._resolveTexture();
            system._resolveTexture = null;
        }
    }

    return { systems, _graph: graph };
}
