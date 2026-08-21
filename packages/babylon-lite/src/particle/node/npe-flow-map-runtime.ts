import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Color4, Mat4, Vec2, Vec3 } from "../../math/types.js";
import { mat4Translation } from "../../math/mat4-translation.js";
import { mat4GetTranslationToRef } from "../../math/mat4-transform.js";
import { createParticleSystem, type ParticleSystem } from "../particle-system.js";
import { cpuTextureSourceBlock } from "./blocks/cpu-texture-source-block.js";
import { updateFlowMapBlock } from "./blocks/update-flow-map-block.js";
import type { BuildNodeParticleOptions, NodeParticleSet, NpeBlockEvaluator, NpeBuildContext, NpeBuildState } from "./npe-build.js";
import { loadNpeBlockEvaluator } from "./npe-registry.js";
import type { ParticleGraph, ParsedParticleBlock, ParsedParticleInput } from "./npe-types.js";
import type { NpeGetter, NpeValue } from "./npe-value.js";

function isInputConnected(input: ParsedParticleInput | undefined): input is ParsedParticleInput & { targetBlockId: number; targetConnectionName: string } {
    return input?.targetBlockId != null && input.targetConnectionName != null;
}

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

/** @internal Dynamically loaded implementation for the public flow-map builder. */
export async function buildNodeParticleSetWithFlowMapsRuntime(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    options: BuildNodeParticleOptions
): Promise<NodeParticleSet> {
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
            const value = options.emitter ?? { ...emitter };
            emitterWorldMatrix = mat4Translation(value.x, value.y, value.z);
            emitter.x = value.x;
            emitter.y = value.y;
            emitter.z = value.z;
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
        const outputs = new Map<string, NpeGetter>();
        const built = new Set<number | ParsedParticleBlock>();
        const ctx: NpeBuildContext = {
            state,
            engine,
            input(block, name, fallback) {
                const input = block.inputs.find((candidate) => candidate.name === name);
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
                return isInputConnected(block.inputs.find((input) => input.name === name));
            },
            setOutput(blockId, name, getter) {
                outputs.set(`${blockId}:${name}`, getter);
            },
            addBuildPromise(promise) {
                buildPromises.push(promise);
            },
        };

        const buildBlock = async (blockId: number, evaluatorOverride?: NpeBlockEvaluator): Promise<void> => {
            const block = graph.blocks.get(blockId);
            if (!block) {
                return;
            }
            const buildKey = evaluatorOverride ? block : blockId;
            if (built.has(buildKey)) {
                return;
            }
            built.add(buildKey);
            for (const input of block.inputs) {
                if (input.name === "particle" && isInputConnected(input)) {
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
            const isFlowMap = block.className === "UpdateFlowMapBlock";
            const evaluator =
                evaluatorOverride ??
                (isFlowMap
                    ? updateFlowMapBlock
                    : scalarOnce
                      ? (await import("./blocks/particle-random-once-block.js")).particleRandomOnceBlock
                      : localShape
                        ? await (await import("./npe-registry-local-shapes.js")).loadLocalShapeEvaluator(block.className)
                        : variant
                          ? await (await import("./npe-registry-variants.js")).loadVariantBlockEvaluator(block)
                          : await loadNpeBlockEvaluator(block.className));
            for (const input of block.inputs) {
                if (input.name !== "particle" && isInputConnected(input)) {
                    await buildBlock(input.targetBlockId, isFlowMap && input.name === "flowMap" ? cpuTextureSourceBlock : undefined);
                }
            }
            evaluator.build(block, ctx);
        };

        await buildBlock(systemId);
        system._emitter = state;
        systems.push(system);
    }

    await Promise.all(buildPromises);
    return { systems, _graph: graph };
}
