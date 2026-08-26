import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { buildNodeParticleSetWithBlendModes } from "../../../packages/babylon-lite/src/particle/node/npe-blend-modes";
import { buildNodeParticleSetWithEmitterProvider } from "../../../packages/babylon-lite/src/particle/node/npe-emitter-provider";
import { buildNodeParticleSetWithFlowMaps } from "../../../packages/babylon-lite/src/particle/node/npe-flow-map";
import { buildNodeParticleSetWithNoiseTextures } from "../../../packages/babylon-lite/src/particle/node/npe-noise";
import { parseNodeParticleSetFromSnippet } from "../../../packages/babylon-lite/src/particle/node/node-particle";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { buildNodeParticleSetWithTextureUpdates } from "../../../packages/babylon-lite/src/particle/node/npe-texture-updates";
import { mat4Identity } from "../../../packages/babylon-lite/src/math/mat4-identity";
import { normalizeNodeParticleGraph } from "../../../packages/babylon-lite/src/index";
import type { ParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";

interface GraphSource {
    blocks: Array<Record<string, unknown>>;
}

interface Connection {
    targetBlockId: number;
    targetConnectionName: string;
}

function appendTeleport(blocks: GraphSource["blocks"], source: Connection, ids: { next: number }): Connection {
    const inputId = ids.next++;
    const outputId = ids.next++;
    blocks.push(
        {
            customType: "BABYLON.ParticleTeleportInBlock",
            id: inputId,
            inputs: [{ name: "input", ...source }],
        },
        {
            customType: "BABYLON.ParticleTeleportOutBlock",
            id: outputId,
            entryPoint: inputId,
            inputs: [],
        }
    );
    return { targetBlockId: outputId, targetConnectionName: "output" };
}

function scalarRouteSource(useTeleport: boolean): GraphSource {
    const targetBlockId = useTeleport ? 3 : 1;
    const blocks: Array<Record<string, unknown>> = [
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 1,
            name: "duration",
            type: 0x0002,
            value: 7,
            inputs: [],
        },
        {
            customType: "BABYLON.SystemBlock",
            id: 4,
            inputs: [{ name: "targetStopDuration", targetBlockId, targetConnectionName: "output" }],
        },
    ];

    if (useTeleport) {
        blocks.push(
            {
                customType: "BABYLON.ParticleTeleportInBlock",
                id: 2,
                inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
            },
            {
                customType: "BABYLON.ParticleTeleportOutBlock",
                id: 3,
                entryPoint: 2,
                inputs: [],
            }
        );
    }

    return { blocks };
}

function valueStateSource(useTeleport: boolean): GraphSource {
    const blocks: GraphSource["blocks"] = [
        { customType: "BABYLON.ParticleInputBlock", id: 1, type: 0x0002, value: 3, inputs: [] },
        { customType: "BABYLON.ParticleInputBlock", id: 2, type: 0x0004, value: [2, 4], inputs: [] },
        { customType: "BABYLON.ParticleInputBlock", id: 3, type: 0x0008, value: [1, 2, 3], inputs: [] },
        { customType: "BABYLON.ParticleInputBlock", id: 4, type: 0x0080, value: [0.1, 0.2, 0.3, 0.4], inputs: [] },
    ];
    const ids = { next: 100 };
    const connect = (blockId: number, connectionName: string): Connection => {
        const source = { targetBlockId: blockId, targetConnectionName: connectionName };
        return useTeleport ? appendTeleport(blocks, source, ids) : source;
    };
    blocks.push(
        {
            customType: "BABYLON.CreateParticleBlock",
            id: 10,
            inputs: [
                { name: "lifeTime", ...connect(1, "output") },
                { name: "emitPower", ...connect(1, "output") },
                { name: "scale", ...connect(2, "output") },
                { name: "color", ...connect(4, "output") },
                { name: "colorDead", ...connect(4, "output") },
                { name: "size", ...connect(1, "output") },
            ],
        },
        {
            customType: "BABYLON.PointShapeBlock",
            id: 20,
            inputs: [
                { name: "particle", ...connect(10, "particle") },
                { name: "direction1", ...connect(3, "output") },
                { name: "direction2", ...connect(3, "output") },
            ],
        },
        {
            customType: "BABYLON.SystemBlock",
            id: 30,
            capacity: 1,
            inputs: [{ name: "particle", ...connect(20, "output") }],
        }
    );
    return { blocks };
}

function captureCreationState(system: ParticleSystem): number[] {
    system.createLifeTime!(0);
    system.createPosition!(0);
    system.createDirection!(0);
    system.createEmitPower!(0);
    system.createSize!(0);
    system.createAngle!(0);
    system.createColor!(0);
    system.createColorDead!(0);
    const buffer = system.buffer;
    return [
        buffer.lifeTime[0]!,
        buffer.posX[0]!,
        buffer.posY[0]!,
        buffer.posZ[0]!,
        buffer.dirX[0]!,
        buffer.dirY[0]!,
        buffer.dirZ[0]!,
        buffer.size[0]!,
        buffer.scaleX[0]!,
        buffer.scaleY[0]!,
        buffer.colorR[0]!,
        buffer.colorG[0]!,
        buffer.colorB[0]!,
        buffer.colorA[0]!,
    ];
}

function basicTeleportSource(entryPoint: unknown = 2): GraphSource {
    return {
        blocks: [
            { customType: "BABYLON.ParticleInputBlock", id: 1, type: 0x0002, value: 7, inputs: [] },
            {
                customType: "BABYLON.ParticleTeleportInBlock",
                id: 2,
                inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
            },
            { customType: "BABYLON.ParticleTeleportOutBlock", id: 3, entryPoint, inputs: [] },
            {
                customType: "BABYLON.SystemBlock",
                id: 4,
                inputs: [{ name: "targetStopDuration", targetBlockId: 3, targetConnectionName: "output" }],
            },
        ],
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("NPE graph plumbing", () => {
    it("builds a Teleport scalar route with the same state as its direct graph", async () => {
        const engine = {} as EngineContext;
        const scene = {} as SceneContext;
        const direct = await buildNodeParticleSet(engine, scene, parseNodeParticleSource(scalarRouteSource(false)));
        const graph = parseNodeParticleSource(scalarRouteSource(true));

        await expect(buildNodeParticleSet(engine, scene, graph)).rejects.toThrow('NodeParticle: unsupported value block "ParticleTeleportOutBlock"');
        const teleported = await buildNodeParticleSet(engine, scene, await normalizeNodeParticleGraph(graph));

        expect(direct.systems[0]!.targetStopDuration).toBe(7);
        expect(teleported.systems[0]!.targetStopDuration).toBe(direct.systems[0]!.targetStopDuration);
    });

    it("preserves scalar, vector, color, and particle-flow state through Teleports", async () => {
        const engine = {} as EngineContext;
        const scene = {} as SceneContext;
        const direct = await buildNodeParticleSet(engine, scene, parseNodeParticleSource(valueStateSource(false)));
        const teleported = await buildNodeParticleSet(engine, scene, await normalizeNodeParticleGraph(parseNodeParticleSource(valueStateSource(true))));

        expect(captureCreationState(teleported.systems[0]!)).toEqual(captureCreationState(direct.systems[0]!));
    });

    it("rewrites every opaque connection role to the terminal source", async () => {
        const blocks: GraphSource["blocks"] = [
            { customType: "BABYLON.CreateParticleBlock", id: 1, inputs: [] },
            { customType: "BABYLON.ParticleTextureSourceBlock", id: 2, inputs: [] },
            { customType: "BABYLON.ParticleInputBlock", id: 3, type: 0x0002, value: 1, inputs: [] },
            { customType: "BABYLON.ParticleInputBlock", id: 4, type: 0x0004, value: [2, 3], inputs: [] },
            { customType: "BABYLON.ParticleInputBlock", id: 5, type: 0x0008, value: [4, 5, 6], inputs: [] },
            { customType: "BABYLON.ParticleInputBlock", id: 6, type: 0x0080, value: [0.1, 0.2, 0.3, 0.4], inputs: [] },
        ];
        const ids = { next: 100 };
        blocks.push(
            {
                customType: "BABYLON.ParticleGradientValueBlock",
                id: 7,
                inputs: [{ name: "value", ...appendTeleport(blocks, { targetBlockId: 3, targetConnectionName: "output" }, ids) }],
            },
            {
                customType: "BABYLON.ParticleGradientBlock",
                id: 8,
                inputs: [
                    { name: "value0", ...appendTeleport(blocks, { targetBlockId: 7, targetConnectionName: "output" }, ids) },
                    { name: "gradient", ...appendTeleport(blocks, { targetBlockId: 3, targetConnectionName: "output" }, ids) },
                ],
            },
            {
                customType: "BABYLON.CreateParticleBlock",
                id: 9,
                inputs: [
                    { name: "scale", value: [9, 9], valueType: "BABYLON.Vector2", ...appendTeleport(blocks, { targetBlockId: 4, targetConnectionName: "output" }, ids) },
                    { name: "color", ...appendTeleport(blocks, { targetBlockId: 6, targetConnectionName: "output" }, ids) },
                ],
            },
            {
                customType: "BABYLON.PointShapeBlock",
                id: 10,
                inputs: [
                    { name: "particle", ...appendTeleport(blocks, { targetBlockId: 9, targetConnectionName: "particle" }, ids) },
                    { name: "direction1", ...appendTeleport(blocks, { targetBlockId: 5, targetConnectionName: "output" }, ids) },
                ],
            },
            {
                customType: "BABYLON.SystemBlock",
                id: 20,
                inputs: [
                    { name: "particle", ...appendTeleport(blocks, { targetBlockId: 10, targetConnectionName: "output" }, ids) },
                    { name: "texture", ...appendTeleport(blocks, { targetBlockId: 2, targetConnectionName: "texture" }, ids) },
                    { name: "onStart", ...appendTeleport(blocks, { targetBlockId: 3, targetConnectionName: "output" }, ids) },
                    { name: "targetStopDuration", ...appendTeleport(blocks, { targetBlockId: 8, targetConnectionName: "output" }, ids) },
                ],
            }
        );
        const graph = parseNodeParticleSource({ blocks });
        const normalized = await normalizeNodeParticleGraph(graph);
        const input = (blockId: number, name: string) => normalized.blocks.get(blockId)!.inputs.find((candidate) => candidate.name === name)!;

        expect(input(20, "particle")).toMatchObject({ targetBlockId: 10, targetConnectionName: "output" });
        expect(input(20, "texture")).toMatchObject({ targetBlockId: 2, targetConnectionName: "texture" });
        expect(input(20, "onStart")).toMatchObject({ targetBlockId: 3, targetConnectionName: "output" });
        expect(input(20, "targetStopDuration")).toMatchObject({ targetBlockId: 8, targetConnectionName: "output" });
        expect(input(10, "particle")).toMatchObject({ targetBlockId: 9, targetConnectionName: "particle" });
        expect(input(10, "direction1")).toMatchObject({ targetBlockId: 5, targetConnectionName: "output" });
        expect(input(9, "scale")).toEqual({ name: "scale", value: [9, 9], valueType: "BABYLON.Vector2", targetBlockId: 4, targetConnectionName: "output" });
        expect(input(9, "color")).toMatchObject({ targetBlockId: 6, targetConnectionName: "output" });
        expect(input(8, "value0")).toMatchObject({ targetBlockId: 7, targetConnectionName: "output" });
        expect(input(8, "gradient")).toMatchObject({ targetBlockId: 3, targetConnectionName: "output" });
        expect(input(7, "value")).toMatchObject({ targetBlockId: 3, targetConnectionName: "output" });
    });

    it("keeps specialized flow-map texture evaluation keyed by the consumer input", async () => {
        const pixels = new Uint8ClampedArray([255, 128, 128, 255]);
        const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => ({}) }));
        vi.stubGlobal("fetch", fetchMock);
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
        );
        vi.stubGlobal(
            "OffscreenCanvas",
            vi.fn(function (this: { getContext: () => unknown }) {
                this.getContext = () => ({ drawImage: vi.fn(), getImageData: () => ({ data: pixels }) });
            })
        );
        const graph = parseNodeParticleSource({
            blocks: [
                { customType: "BABYLON.CreateParticleBlock", id: 1, inputs: [] },
                { customType: "BABYLON.ParticleTextureSourceBlock", id: 2, textureDataUrl: "data:image/png;base64,AA==", invertY: false, inputs: [] },
                {
                    customType: "BABYLON.ParticleTeleportInBlock",
                    id: 3,
                    inputs: [{ name: "input", targetBlockId: 2, targetConnectionName: "texture" }],
                },
                { customType: "BABYLON.ParticleTeleportOutBlock", id: 4, entryPoint: 3, inputs: [] },
                {
                    customType: "BABYLON.UpdateFlowMapBlock",
                    id: 5,
                    inputs: [
                        { name: "particle", targetBlockId: 1, targetConnectionName: "particle" },
                        { name: "flowMap", targetBlockId: 4, targetConnectionName: "output" },
                    ],
                },
                { customType: "BABYLON.SystemBlock", id: 6, inputs: [{ name: "particle", targetBlockId: 5, targetConnectionName: "output" }] },
            ],
        });
        const scene = { surface: { canvas: { width: 1, height: 1 } }, _beforeRender: [], _deferredBuilders: [] } as unknown as SceneContext;
        const set = await buildNodeParticleSetWithFlowMaps({} as EngineContext, scene, await normalizeNodeParticleGraph(graph));

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(set.systems[0]!.updateSteps).toHaveLength(1);
        expect(set._graph.blocks.get(5)!.inputs.find((input) => input.name === "flowMap")).toMatchObject({ targetBlockId: 2, targetConnectionName: "texture" });
    });

    it("keeps parser output free of graph-plumbing metadata and preserves last-record-wins behavior", () => {
        const ordinary = parseNodeParticleSource(scalarRouteSource(false));
        const teleported = parseNodeParticleSource(scalarRouteSource(true));
        const duplicate = parseNodeParticleSource({
            blocks: [
                { customType: "BABYLON.SystemBlock", id: 4, inputs: [] },
                { customType: "BABYLON.ParticleInputBlock", id: 1, name: "first", inputs: [] },
                { customType: "BABYLON.ParticleInputBlock", id: 1, name: "last", inputs: [] },
            ],
        });

        expect(Object.keys(ordinary)).toEqual(["blocks", "systemBlockIds"]);
        expect(Object.keys(teleported)).toEqual(["blocks", "systemBlockIds"]);
        expect(duplicate.blocks.get(1)!.name).toBe("last");
    });

    it("returns ordinary graphs exactly and marks a detached malformed Teleport as normalized", async () => {
        const ordinary = parseNodeParticleSource(scalarRouteSource(false));
        const detachedSource = scalarRouteSource(false);
        detachedSource.blocks.push(
            { customType: "BABYLON.ParticleTeleportInBlock", id: 10, inputs: [] },
            { customType: "BABYLON.ParticleTeleportOutBlock", id: 11, entryPoint: "", inputs: [] }
        );
        const detached = parseNodeParticleSource(detachedSource);
        const normalized = await normalizeNodeParticleGraph(detached);

        expect(await normalizeNodeParticleGraph(ordinary)).toBe(ordinary);
        expect(Object.keys(detached)).toEqual(["blocks", "systemBlockIds"]);
        expect(normalized).not.toBe(detached);
        expect(normalized._isGraphPlumbingNormalized).toBe(true);
        expect(normalized.blocks).toBe(detached.blocks);
        expect(normalized.systemBlockIds).toBe(detached.systemBlockIds);
        expect((await buildNodeParticleSet({} as EngineContext, {} as SceneContext, normalized))._graph).toBe(normalized);
    });

    it("reuses the normalized graph across repeated normalization and rebuilding", async () => {
        const parsed = parseNodeParticleSource(scalarRouteSource(true));
        const normalized = await normalizeNodeParticleGraph(parsed);

        expect(normalized).not.toBe(parsed);
        expect(Object.keys(normalized)).toEqual(["blocks", "systemBlockIds", "_isGraphPlumbingNormalized"]);
        expect(await normalizeNodeParticleGraph(normalized)).toBe(normalized);

        const first = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, normalized);
        const rebuilt = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, first._graph);
        expect(first._graph._isGraphPlumbingNormalized).toBe(true);
        expect(rebuilt._graph).toBe(first._graph);
    });

    it("does not mark or activate Phase 3C classes", async () => {
        const source: GraphSource = {
            blocks: [
                { customType: "BABYLON.ParticleInputBlock", id: 1, inputs: [] },
                {
                    customType: "BABYLON.ParticleLocalVariableBlock",
                    id: 2,
                    inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
                },
                { customType: "BABYLON.SystemBlock", id: 3, inputs: [{ name: "targetStopDuration", targetBlockId: 2, targetConnectionName: "output" }] },
            ],
        };
        const graph = parseNodeParticleSource(source);

        expect(await normalizeNodeParticleGraph(graph)).toBe(graph);
        await expect(buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph)).rejects.toThrow('NodeParticle: unsupported value block "ParticleLocalVariableBlock"');
    });

    it("leaves a TeleportIn-only malformed graph unmarked and unsupported", async () => {
        const graph = parseNodeParticleSource({
            blocks: [
                { customType: "BABYLON.ParticleTeleportInBlock", id: 1, inputs: [] },
                { customType: "BABYLON.SystemBlock", id: 2, inputs: [{ name: "targetStopDuration", targetBlockId: 1, targetConnectionName: "output" }] },
            ],
        });

        expect(await normalizeNodeParticleGraph(graph)).toBe(graph);
        await expect(buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph)).rejects.toThrow('NodeParticle: unsupported value block "ParticleTeleportInBlock"');
    });

    it("normalizes fan-out, chains, endpoint zero, and multiple roots without mutating source data", async () => {
        const source: GraphSource = {
            blocks: [
                {
                    customType: "BABYLON.ParticleTeleportInBlock",
                    id: 0,
                    inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
                },
                { customType: "BABYLON.ParticleInputBlock", id: 1, type: 0x0002, value: 7, inputs: [] },
                { customType: "BABYLON.ParticleTeleportOutBlock", id: 2, entryPoint: 0, inputs: [] },
                { customType: "BABYLON.ParticleTeleportOutBlock", id: 3, entryPoint: 0, inputs: [] },
                {
                    customType: "BABYLON.ParticleTeleportInBlock",
                    id: 4,
                    inputs: [{ name: "input", targetBlockId: 3, targetConnectionName: "output" }],
                },
                { customType: "BABYLON.ParticleTeleportOutBlock", id: 5, entryPoint: 4, inputs: [] },
                {
                    customType: "BABYLON.SystemBlock",
                    id: 10,
                    inputs: [
                        { name: "emitRate", value: 9, valueType: "number" },
                        { name: "targetStopDuration", value: 99, valueType: "number", targetBlockId: 2, targetConnectionName: "output" },
                    ],
                },
                { customType: "BABYLON.SystemBlock", id: 11, inputs: [{ name: "targetStopDuration", targetBlockId: 5, targetConnectionName: "output" }] },
            ],
        };
        const rawSnapshot = structuredClone(source);
        const graph = parseNodeParticleSource(source);
        const originalRoot = graph.blocks.get(10)!;
        const originalEmitRate = originalRoot.inputs[0]!;
        const originalDuration = originalRoot.inputs[1]!;
        const normalized = await normalizeNodeParticleGraph(graph);

        expect(normalized).not.toBe(graph);
        expect(normalized.systemBlockIds).toBe(graph.systemBlockIds);
        expect(normalized.blocks.get(1)).toBe(graph.blocks.get(1));
        expect(normalized.blocks.get(2)).toBe(graph.blocks.get(2));
        expect(normalized.blocks.get(10)).not.toBe(originalRoot);
        expect(normalized.blocks.get(10)!.inputs[0]).toBe(originalEmitRate);
        expect(normalized.blocks.get(10)!.inputs[1]).toEqual({
            name: "targetStopDuration",
            value: 99,
            valueType: "number",
            targetBlockId: 1,
            targetConnectionName: "output",
        });
        expect(normalized.blocks.get(11)!.inputs[0]).toMatchObject({ targetBlockId: 1, targetConnectionName: "output" });
        expect(originalDuration).toMatchObject({ targetBlockId: 2, targetConnectionName: "output" });
        expect(source).toEqual(rawSnapshot);
        expect(graph.blocks.get(10)).toBe(originalRoot);

        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, normalized);
        expect(set.systems.map((system) => system.targetStopDuration)).toEqual([7, 7]);
    });

    it.each(["", Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1])("rejects invalid entryPoint %s", async (entryPoint) => {
        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(basicTeleportSource(entryPoint)))).rejects.toThrow(
            "NodeParticle: ParticleTeleportOutBlock 3 has invalid entryPoint"
        );
    });

    it("rejects a missing endpoint", async () => {
        const source = basicTeleportSource(99);
        source.blocks.splice(1, 1);
        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(source))).rejects.toThrow("NodeParticle: ParticleTeleportOutBlock 3 references missing entryPoint 99");
    });

    it("rejects an endpoint with the wrong class", async () => {
        const source = basicTeleportSource();
        source.blocks[1] = { customType: "BABYLON.ParticleInputBlock", id: 2, inputs: [] };
        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(source))).rejects.toThrow(
            "NodeParticle: ParticleTeleportOutBlock 3 entryPoint 2 is not ParticleTeleportInBlock"
        );
    });

    it.each([
        ["TeleportOut", 3, "ParticleTeleportOutBlock"],
        ["TeleportIn", 2, "ParticleTeleportInBlock"],
    ] as const)("uses the final parsed block for a repeated %s route id", async (_name, repeatedId, finalClassName) => {
        const source = basicTeleportSource();
        source.blocks.unshift({ customType: "BABYLON.ParticleInputBlock", id: repeatedId, inputs: [] });
        const graph = parseNodeParticleSource(source);
        const normalized = await normalizeNodeParticleGraph(graph);

        expect(graph.blocks.get(repeatedId)!.className).toBe(finalClassName);
        expect(normalized.blocks.get(4)!.inputs[0]).toMatchObject({ targetBlockId: 1, targetConnectionName: "output" });
        expect((await buildNodeParticleSet({} as EngineContext, {} as SceneContext, normalized)).systems[0]!.targetStopDuration).toBe(7);
    });

    it("applies the endpoint-class diagnostic to the final parsed block", async () => {
        const source = basicTeleportSource();
        source.blocks.push({ customType: "BABYLON.ParticleInputBlock", id: 2, inputs: [] });
        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(source))).rejects.toThrow(
            "NodeParticle: ParticleTeleportOutBlock 3 entryPoint 2 is not ParticleTeleportInBlock"
        );
    });

    it("rejects a disconnected TeleportIn input", async () => {
        const source = basicTeleportSource();
        source.blocks[1] = { customType: "BABYLON.ParticleTeleportInBlock", id: 2, inputs: [{ name: "input", targetBlockId: 1 }] };
        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(source))).rejects.toThrow("NodeParticle: ParticleTeleportInBlock 2 input is not connected");
    });

    it("rejects a reachable consumer edge that directly targets a TeleportIn output", async () => {
        const source = basicTeleportSource();
        source.blocks[3] = {
            customType: "BABYLON.SystemBlock",
            id: 4,
            inputs: [{ name: "targetStopDuration", targetBlockId: 2, targetConnectionName: "output" }],
        };

        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(source))).rejects.toThrowError(/^NodeParticle: ParticleTeleportInBlock 2 does not expose output "output"$/);
    });

    it("reports a malformed particle Teleport route before a malformed non-particle route", async () => {
        const source: GraphSource = {
            blocks: [
                { customType: "BABYLON.ParticleTeleportOutBlock", id: 1, entryPoint: 91, inputs: [] },
                { customType: "BABYLON.ParticleTeleportOutBlock", id: 2, entryPoint: 92, inputs: [] },
                {
                    customType: "BABYLON.SystemBlock",
                    id: 3,
                    inputs: [
                        { name: "targetStopDuration", targetBlockId: 2, targetConnectionName: "output" },
                        { name: "particle", targetBlockId: 1, targetConnectionName: "notParticleOutput" },
                    ],
                },
            ],
        };

        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(source))).rejects.toThrowError(
            /^NodeParticle: ParticleTeleportOutBlock 1 does not expose output "notParticleOutput"$/
        );
    });

    it("rejects a TeleportOut output-name mismatch", async () => {
        const source = basicTeleportSource();
        source.blocks[3] = {
            customType: "BABYLON.SystemBlock",
            id: 4,
            inputs: [{ name: "targetStopDuration", targetBlockId: 3, targetConnectionName: "notOutput" }],
        };
        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(source))).rejects.toThrow('NodeParticle: ParticleTeleportOutBlock 3 does not expose output "notOutput"');
    });

    it("rejects a Teleport plumbing cycle with the repeated route", async () => {
        const source: GraphSource = {
            blocks: [
                {
                    customType: "BABYLON.ParticleTeleportInBlock",
                    id: 2,
                    inputs: [{ name: "input", targetBlockId: 5, targetConnectionName: "output" }],
                },
                { customType: "BABYLON.ParticleTeleportOutBlock", id: 3, entryPoint: 2, inputs: [] },
                {
                    customType: "BABYLON.ParticleTeleportInBlock",
                    id: 4,
                    inputs: [{ name: "input", targetBlockId: 3, targetConnectionName: "output" }],
                },
                { customType: "BABYLON.ParticleTeleportOutBlock", id: 5, entryPoint: 4, inputs: [] },
                { customType: "BABYLON.SystemBlock", id: 6, inputs: [{ name: "targetStopDuration", targetBlockId: 3, targetConnectionName: "output" }] },
            ],
        };

        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(source))).rejects.toThrow("NodeParticle: graph plumbing cycle 3 -> 2 -> 5 -> 4 -> 3");
    });

    it.each([
        ["flow-map", buildNodeParticleSetWithFlowMaps],
        ["noise", buildNodeParticleSetWithNoiseTextures],
        ["combined texture-update", buildNodeParticleSetWithTextureUpdates],
        ["blend-mode", buildNodeParticleSetWithBlendModes],
    ] as const)("builds one explicitly normalized graph through the %s builder", async (_name, builder) => {
        const graph = await normalizeNodeParticleGraph(parseNodeParticleSource(scalarRouteSource(true)));
        const set = await builder({} as EngineContext, {} as SceneContext, graph);

        expect(set.systems[0]!.targetStopDuration).toBe(7);
    });

    it("builds one explicitly normalized graph through the emitter-provider builder", async () => {
        const graph = await normalizeNodeParticleGraph(parseNodeParticleSource(scalarRouteSource(true)));
        const set = await buildNodeParticleSetWithEmitterProvider({} as EngineContext, {} as SceneContext, graph, () => mat4Identity());

        expect(set.systems[0]!.targetStopDuration).toBe(7);
    });

    it("normalizes through the inline snippet delegation", async () => {
        const set = await parseNodeParticleSetFromSnippet({} as EngineContext, {} as SceneContext, "", { json: scalarRouteSource(true) });

        expect(set.systems[0]!.targetStopDuration).toBe(7);
        expect(set._graph._isGraphPlumbingNormalized).toBe(true);
    });

    it("normalizes through the fetched snippet delegation", async () => {
        const source = scalarRouteSource(true);
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ jsonPayload: JSON.stringify({ nodeParticle: JSON.stringify(source) }) }),
        }));
        vi.stubGlobal("fetch", fetchMock);

        const set = await parseNodeParticleSetFromSnippet({} as EngineContext, {} as SceneContext, "TELEPORT#1", { snippetServer: "https://snippets.invalid" });

        expect(fetchMock).toHaveBeenCalledWith("https://snippets.invalid/TELEPORT/1");
        expect(set.systems[0]!.targetStopDuration).toBe(7);
        expect(set._graph._isGraphPlumbingNormalized).toBe(true);
    });

    it("builds a non-Teleport snippet without replacing or marking its parsed graph", async () => {
        const set = await parseNodeParticleSetFromSnippet({} as EngineContext, {} as SceneContext, "", { json: scalarRouteSource(false) });

        expect(set.systems[0]!.targetStopDuration).toBe(7);
        expect(Object.keys(set._graph)).toEqual(["blocks", "systemBlockIds"]);
    });

    it("keeps graph recognition out of the parser and all owning builders", () => {
        const nodeDirectory = resolve(__dirname, "../../../packages/babylon-lite/src/particle/node");
        for (const file of ["npe-parser.ts", "npe-build.ts", "npe-flow-map-runtime.ts", "npe-texture-update-runtime.ts"]) {
            const source = readFileSync(resolve(nodeDirectory, file), "utf8");
            expect(source, file).not.toContain("_hasGraphPlumbing");
            expect(source, file).not.toContain("npe-graph-plumbing");
        }
    });

    it("keeps the heavy runtime behind the thin helper and the async snippet boundary", () => {
        const nodeDirectory = resolve(__dirname, "../../../packages/babylon-lite/src/particle/node");
        const helperSource = readFileSync(resolve(nodeDirectory, "npe-graph-plumbing.ts"), "utf8");
        const snippetSource = readFileSync(resolve(nodeDirectory, "node-particle.ts"), "utf8");

        expect(helperSource).toContain('import("./npe-graph-plumbing-runtime.js")');
        expect(helperSource).not.toMatch(/^(?!\s*import type).*from ["']\.\/npe-graph-plumbing-runtime/m);
        expect(snippetSource).toContain("await normalizeNodeParticleGraph(parseNodeParticleSource(source))");
    });

    it("adds no Teleport evaluator or registry implementation", () => {
        const nodeDirectory = resolve(__dirname, "../../../packages/babylon-lite/src/particle/node");
        const blockNames = readdirSync(resolve(nodeDirectory, "blocks"));
        const registrySource = readdirSync(nodeDirectory)
            .filter((name) => name.startsWith("npe-registry") && name.endsWith(".ts"))
            .map((name) => readFileSync(resolve(nodeDirectory, name), "utf8"))
            .join("\n");

        expect(blockNames.filter((name) => name.toLowerCase().includes("teleport"))).toEqual([]);
        expect(registrySource).not.toContain("ParticleTeleport");
    });
});
