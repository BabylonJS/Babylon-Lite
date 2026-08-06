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
import { mat4Translation } from "../../math/mat4-translation.js";
import { mat4GetTranslationToRef } from "../../math/mat4-transform.js";
import type { ParticleGraph, ParsedParticleBlock, ParsedParticleInput } from "./npe-types.js";
import type { ParticleBuffer } from "../particle-buffer.js";
import { createParticleSystem, type ParticleSystem } from "../particle-system.js";
import type { NpeGetter, NpeGraphValue, NpeValue } from "./npe-value.js";
import { loadNpeBlockEvaluator } from "./npe-registry.js";

function isInputConnected(input: ParsedParticleInput | undefined): input is ParsedParticleInput & { targetBlockId: number; targetConnectionName: string } {
    return input?.targetBlockId != null && input.targetConnectionName != null;
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
    isLocal: boolean;
    scene: SceneContext;
    textureBaseUrl?: string;
    billboardTextureBlockId?: number;
}

/** Build context handed to each NPE block evaluator. */
export interface NpeBuildContext {
    state: NpeBuildState;
    engine: EngineContext;
    input<T extends NpeGraphValue = NpeValue>(block: ParsedParticleBlock, name: string, fallback?: NpeGetter<T>): NpeGetter<T>;
    isConnected(block: ParsedParticleBlock, name: string): boolean;
    setOutput<T extends NpeGraphValue>(blockId: number, name: string, getter: NpeGetter<T>): void;
    addBuildPromise(promise: Promise<void>): void;
}

/** An NPE block evaluator: wires a parsed block into the runtime during the build walk. */
export interface NpeBlockEvaluator {
    build(block: ParsedParticleBlock, ctx: NpeBuildContext): void;
}

/** A built data-oriented particle set. */
export interface NodeParticleSet {
    readonly systems: ParticleSystem[];
    /** @internal */
    _graph: ParticleGraph;
}

/** Options for building a node-particle set. */
export interface BuildNodeParticleOptions {
    emitter?: Vec3;
    emitterWorldMatrix?: Mat4;
    textureBaseUrl?: string;
}

/** Build data-oriented particle systems from a parsed graph. */
export async function buildNodeParticleSet(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options: BuildNodeParticleOptions = {}): Promise<NodeParticleSet> {
    const systems: ParticleSystem[] = [];
    const buildPromises: Promise<void>[] = [];

    for (const systemId of graph.systemBlockIds) {
        const systemBlock = graph.blocks.get(systemId);
        if (!systemBlock) {
            continue;
        }

        const capacity = typeof systemBlock.serialized.capacity === "number" ? systemBlock.serialized.capacity : 1000;
        const system = createParticleSystem(capacity);

        let emitterWorldMatrix: Mat4;
        const emitter: Vec3 = { x: 0, y: 0, z: 0 };
        if (options.emitterWorldMatrix) {
            emitterWorldMatrix = options.emitterWorldMatrix;
            mat4GetTranslationToRef(emitterWorldMatrix, emitter);
        } else {
            const e = options.emitter ?? { x: 0, y: 0, z: 0 };
            emitterWorldMatrix = mat4Translation(e.x, e.y, e.z);
            emitter.x = e.x;
            emitter.y = e.y;
            emitter.z = e.z;
        }
        const billboardTextureInput = systemBlock.inputs.find((input) => input.name === "texture");
        const state: NpeBuildState = {
            system,
            buffer: system.buffer,
            capacity,
            emitter,
            emitterWorldMatrix,
            isLocal: systemBlock.serialized.isLocal === true,
            scene,
            textureBaseUrl: options.textureBaseUrl,
            billboardTextureBlockId: isInputConnected(billboardTextureInput) ? billboardTextureInput.targetBlockId : undefined,
        };

        const outputs = new Map<string, NpeGetter<NpeGraphValue>>();
        const built = new Set<number>();

        const ctx: NpeBuildContext = {
            state,
            engine,
            input<T extends NpeGraphValue = NpeValue>(block: ParsedParticleBlock, name: string, fallback?: NpeGetter<T>): NpeGetter<T> {
                const input = block.inputs.find((i) => i.name === name);
                if (isInputConnected(input)) {
                    const getter = outputs.get(`${input.targetBlockId}:${input.targetConnectionName}`);
                    if (getter) {
                        return getter as NpeGetter<T>;
                    }
                    throw new Error(`NodeParticle: unresolved connection ${block.className}.${name}`);
                }
                if (input) {
                    const literal = parseInputLiteral(input);
                    if (literal !== undefined) {
                        return (() => literal) as unknown as NpeGetter<T>;
                    }
                }
                return fallback ?? (() => null as unknown as T);
            },
            isConnected(block, name) {
                const input = block.inputs.find((i) => i.name === name);
                return isInputConnected(input);
            },
            setOutput<T extends NpeGraphValue>(blockId: number, name: string, getter: NpeGetter<T>) {
                outputs.set(`${blockId}:${name}`, getter as NpeGetter<NpeGraphValue>);
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
            const contextualSource = typeof block.serialized.contextualValue === "number" ? block.serialized.contextualValue : 0;
            const left = block.inputs.find((input) => input.name === "left");
            const right = block.inputs.find((input) => input.name === "right");
            const onceValueType = block.inputs.find((input) => input.name === "min")?.valueType ?? block.inputs.find((input) => input.name === "max")?.valueType ?? "number";
            const scalarOnce = block.className === "ParticleRandomBlock" && block.serialized.lockMode === 3 && onceValueType === "number";
            const localShape = state.isLocal && block.className.endsWith("ShapeBlock");
            const variant =
                (block.className === "ParticleInputBlock" && contextualSource !== 0 && !((contextualSource <= 6 && contextualSource !== 2) || contextualSource === 0x17)) ||
                (block.className === "ParticleRandomBlock" && block.serialized.lockMode === 3 && !scalarOnce) ||
                (block.className === "ParticleMathBlock" && left?.targetBlockId === right?.targetBlockId && left?.targetConnectionName === right?.targetConnectionName) ||
                (block.className === "SystemBlock" && isInputConnected(block.inputs.find((input) => input.name === "emitRate"))) ||
                (block.className === "SetupSpriteSheetBlock" && block.serialized.randomStartCell === true);
            const evaluator = scalarOnce
                ? (await import("./blocks/particle-random-once-block.js")).particleRandomOnceBlock
                : localShape
                  ? await (await import("./npe-registry-local-shapes.js")).loadLocalShapeEvaluator(block.className)
                  : variant
                    ? await (await import("./npe-registry-variants.js")).loadVariantBlockEvaluator(block)
                    : await loadNpeBlockEvaluator(block.className);
            evaluator.build(block, ctx);
        };

        await buildBlock(systemId);

        systems.push(system);
    }

    await Promise.all(buildPromises);
    return { systems, _graph: graph };
}
