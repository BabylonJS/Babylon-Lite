/**
 * Data-oriented Node-Particle build.
 *
 * Reuses the shared parser's {@link ParticleGraph} and walks inputs in post-order, so upstream outputs
 * resolve before downstream reads and update steps retain graph order. Block evaluators produce
 * column-writing {@link ParticleStep}s and index-based {@link NpeGetter}s. One {@link ParticleSystem} is produced
 * per `SystemBlock` root.
 */
import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Vec3, Mat4, Vec2, Color4 } from "../../math/types.js";
import { createTranslationMat4 } from "../../math/create-translation-mat4.js";
import { mat4GetTranslationToRef } from "../../math/mat4-transform.js";
import type { ParticleGraph, ParsedParticleBlock, ParsedParticleInput } from "./npe-types.js";
import type { ParticleBuffer } from "../particle-buffer.js";
import { createParticleSystem, type ParticleEmitterInverse, type ParticleSystem } from "../particle-system.js";
import type { NpeGetter, NpeValue } from "./npe-value.js";
import { loadNpeBlock } from "./npe-manifest.js";

function isInputConnected(input: ParsedParticleInput | undefined): input is ParsedParticleInput & { targetBlockId: number; targetConnectionName: string } {
    return input?.targetBlockId != null && input.targetConnectionName != null;
}

/**
 * Load the evaluator of every block class reachable from a system block in parallel. Each class is its own
 * lazy chunk, so resolving them during the depth-first build would cost one round trip per class.
 */
async function loadReachableBlocks(graph: ParticleGraph): Promise<Map<string, NpeBlockEvaluator>> {
    const classNames = new Set<string>();
    const visited = new Set<number>();
    const pending = [...graph.systemBlockIds];
    for (let blockId = pending.pop(); blockId !== undefined; blockId = pending.pop()) {
        const block = graph.blocks.get(blockId);
        if (!block || visited.has(blockId)) {
            continue;
        }
        visited.add(blockId);
        classNames.add(block.className);
        for (const input of block.inputs) {
            if (isInputConnected(input)) {
                pending.push(input.targetBlockId);
            }
        }
    }
    const evaluators = new Map<string, NpeBlockEvaluator>();
    await Promise.all(
        [...classNames].map(async (name) => {
            evaluators.set(name, await loadNpeBlock(name));
        })
    );
    return evaluators;
}

/** Parse a literal value serialized directly on an unconnected input. */
function parseInputLiteral(input: ParsedParticleInput): NpeValue | undefined {
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
                return { x: array[0] ?? 0, y: array[1] ?? 0 } as Vec2;
            case "BABYLON.Vector3":
                return { x: array[0] ?? 0, y: array[1] ?? 0, z: array[2] ?? 0 } as Vec3;
            case "BABYLON.Color4":
                return { r: array[0] ?? 0, g: array[1] ?? 0, b: array[2] ?? 0, a: array[3] ?? 1 } as Color4;
            default:
                return undefined;
        }
    }
    return undefined;
}

/** Build state shared with every block evaluator during the walk. */
export interface NpeBuildState {
    system: ParticleSystem | null;
    buffer: ParticleBuffer | null;
    capacity: number;
    emitter: Vec3;
    emitterWorldMatrix: Mat4;
    emitterInverseWorldMatrices?: ParticleEmitterInverse[];
    /** @internal Shared only by Loop-scope local-variable evaluators in this system build. */
    _localVariableLoopEpoch?: { value: number };
    isLocal: boolean;
    scene: SceneContext;
    textureBaseUrl?: string;
}

/** Build context handed to each NPE block evaluator. */
export interface NpeBuildContext {
    state: NpeBuildState;
    engine: EngineContext;
    input(block: ParsedParticleBlock, name: string, fallback?: NpeGetter): NpeGetter;
    isConnected(block: ParsedParticleBlock, name: string): boolean;
    setOutput(blockId: number, name: string, getter: NpeGetter): void;
    addBuildPromise(promise: Promise<void>): void;
}

/**
 * An NPE block evaluator: wires a parsed block into the runtime during the build walk. A block that lazy-loads
 * an optional implementation path returns a promise; the walk awaits it before building downstream blocks.
 */
export interface NpeBlockEvaluator {
    build(block: ParsedParticleBlock, ctx: NpeBuildContext): void | Promise<void>;
}

/** A built data-oriented particle set. */
export interface NodeParticleSet {
    readonly systems: ParticleSystem[];
    /** @internal */
    _graph: ParticleGraph;
}

/** Options for building a node-particle set. */
export interface BuildNodeParticleOptions {
    /** Emitter world position (translation-only emitter). Ignored when {@link BuildNodeParticleOptions.emitterWorldMatrix} is set. */
    emitter?: Vec3;
    /** Emitter world matrix (translation + rotation + scale). Takes precedence over {@link BuildNodeParticleOptions.emitter}. */
    emitterWorldMatrix?: Mat4;
    /** Base URL used to resolve relative texture URLs in the graph (mirrors BJS texture-base resolution). */
    textureBaseUrl?: string;
    /** @internal */
    _setupEmitter?: (state: NpeBuildState) => void;
}

/** Build data-oriented particle systems from a parsed graph. */
export async function buildNodeParticleSet(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options: BuildNodeParticleOptions = {}): Promise<NodeParticleSet> {
    const systems: ParticleSystem[] = [];
    const buildPromises: Promise<void>[] = [];
    const evaluators = await loadReachableBlocks(graph);

    for (const systemId of graph.systemBlockIds) {
        const systemBlock = graph.blocks.get(systemId);
        if (!systemBlock) {
            continue;
        }

        const capacity = typeof systemBlock.serialized.capacity === "number" ? systemBlock.serialized.capacity : 1000;
        const system = createParticleSystem(capacity);
        if (typeof systemBlock.name === "string" && systemBlock.name.length > 0) {
            system.name = systemBlock.name;
        }

        let emitterWorldMatrix: Mat4;
        const emitter: Vec3 = { x: 0, y: 0, z: 0 };
        if (options.emitterWorldMatrix) {
            emitterWorldMatrix = options.emitterWorldMatrix;
            mat4GetTranslationToRef(emitterWorldMatrix, emitter);
        } else {
            const e = options.emitter ?? { x: 0, y: 0, z: 0 };
            emitterWorldMatrix = createTranslationMat4(e.x, e.y, e.z);
            emitter.x = e.x;
            emitter.y = e.y;
            emitter.z = e.z;
        }
        const state: NpeBuildState = {
            system,
            buffer: system.buffer,
            capacity,
            emitter,
            emitterWorldMatrix,
            isLocal: systemBlock.serialized.isLocal === true,
            scene,
            textureBaseUrl: options.textureBaseUrl,
        };
        options._setupEmitter?.(state);

        const outputs = new Map<string, NpeGetter>();
        const built = new Set<number>();

        const ctx: NpeBuildContext = {
            state,
            engine,
            input(block, name, fallback) {
                const input = block.inputs.find((i) => i.name === name);
                if (isInputConnected(input)) {
                    const getter = outputs.get(`${input.targetBlockId}:${input.targetConnectionName}`);
                    if (getter) {
                        return getter;
                    }
                    throw new Error(`NodeParticle: unresolved connection ${block.className}.${name}`);
                }
                if (input) {
                    const literal = parseInputLiteral(input);
                    if (literal !== undefined) {
                        return () => literal;
                    }
                }
                return fallback ?? (() => null as unknown as NpeValue);
            },
            isConnected(block, name) {
                const input = block.inputs.find((i) => i.name === name);
                return isInputConnected(input);
            },
            setOutput(blockId, name, getter) {
                outputs.set(`${blockId}:${name}`, getter);
            },
            addBuildPromise(promise) {
                buildPromises.push(promise);
            },
        };

        const buildBlock = async (blockId: number): Promise<void> => {
            if (built.has(blockId)) {
                return;
            }
            built.add(blockId);
            const block = graph.blocks.get(blockId);
            if (!block) {
                return;
            }
            // Recurse the `particle` chain first so the system + buffer exist before any value chain
            // (contextual sources, per-particle random) builds, regardless of serialized input order.
            for (const input of block.inputs) {
                if (input.name === "particle" && isInputConnected(input)) {
                    await buildBlock(input.targetBlockId);
                }
            }
            for (const input of block.inputs) {
                if (input.name !== "particle" && isInputConnected(input)) {
                    await buildBlock(input.targetBlockId);
                }
            }
            await (evaluators.get(block.className) as NpeBlockEvaluator).build(block, ctx);
        };

        await buildBlock(systemId);
        systems.push(system);
    }

    await Promise.all(buildPromises);
    return { systems, _graph: graph };
}
