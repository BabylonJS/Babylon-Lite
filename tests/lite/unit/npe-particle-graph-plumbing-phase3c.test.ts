import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { mat4Identity } from "../../../packages/babylon-lite/src/math/mat4-identity";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { buildNodeParticleSetWithBlendModes } from "../../../packages/babylon-lite/src/particle/node/npe-blend-modes";
import { buildNodeParticleSetWithEmitterProvider } from "../../../packages/babylon-lite/src/particle/node/npe-emitter-provider";
import { buildNodeParticleSetWithFlowMaps } from "../../../packages/babylon-lite/src/particle/node/npe-flow-map";
import { normalizeNodeParticleGraph } from "../../../packages/babylon-lite/src/particle/node/npe-graph-plumbing";
import { buildNodeParticleSetWithNoiseTextures } from "../../../packages/babylon-lite/src/particle/node/npe-noise";
import { parseNodeParticleSetFromSnippet } from "../../../packages/babylon-lite/src/particle/node/node-particle";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { buildNodeParticleSetWithTextureUpdates } from "../../../packages/babylon-lite/src/particle/node/npe-texture-updates";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

interface GraphSource {
    blocks: Array<Record<string, unknown>>;
}

function localGraph(scope: unknown, useParticle: boolean, useSystem: boolean): GraphSource {
    const blocks: GraphSource["blocks"] = [
        { customType: "BABYLON.ParticleInputBlock", id: 1, type: 0x0002, value: 7, inputs: [] },
        {
            customType: "BABYLON.ParticleLocalVariableBlock",
            id: 2,
            ...(scope === undefined ? {} : { scope }),
            inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
        },
    ];
    const systemInputs: Array<Record<string, unknown>> = [];
    if (useParticle) {
        blocks.push({
            customType: "BABYLON.CreateParticleBlock",
            id: 3,
            inputs: [{ name: "lifeTime", targetBlockId: 2, targetConnectionName: "output" }],
        });
        systemInputs.push({ name: "particle", targetBlockId: 3, targetConnectionName: "particle" });
    }
    if (useSystem) {
        systemInputs.push({ name: "targetStopDuration", targetBlockId: 2, targetConnectionName: "output" });
    }
    blocks.push({ customType: "BABYLON.SystemBlock", id: 4, capacity: 2, inputs: systemInputs });
    return { blocks };
}

function passThroughSource(className: "ParticleElbowBlock" | "ParticleDebugBlock", stackSize?: number): GraphSource {
    return {
        blocks: [
            { customType: "BABYLON.ParticleInputBlock", id: 1, type: 0x0002, value: 7, inputs: [] },
            {
                customType: `BABYLON.${className}`,
                id: 2,
                ...(stackSize === undefined ? {} : { stackSize }),
                inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
            },
            { customType: "BABYLON.SystemBlock", id: 3, inputs: [{ name: "targetStopDuration", targetBlockId: 2, targetConnectionName: "output" }] },
        ],
    };
}

function unsupportedRoleSource(className: "ParticleDebugBlock" | "ParticleLocalVariableBlock", role: string): GraphSource {
    const sourceBlock =
        role === "particle flow"
            ? { customType: "BABYLON.CreateParticleBlock", id: 1, inputs: [] }
            : role === "texture"
              ? { customType: "BABYLON.ParticleTextureSourceBlock", id: 1, inputs: [] }
              : { customType: "BABYLON.ParticleInputBlock", id: 1, type: 0x0002, value: 1, inputs: [] };
    const proxy = {
        customType: `BABYLON.${className}`,
        id: 2,
        scope: 1,
        inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: role === "particle flow" ? "particle" : role === "texture" ? "texture" : "output" }],
    };
    if (role === "gradient metadata") {
        return {
            blocks: [
                sourceBlock,
                proxy,
                { customType: "BABYLON.ParticleGradientBlock", id: 3, inputs: [{ name: "value0", targetBlockId: 2, targetConnectionName: "output" }] },
                { customType: "BABYLON.SystemBlock", id: 4, inputs: [{ name: "targetStopDuration", targetBlockId: 3, targetConnectionName: "output" }] },
            ],
        };
    }
    return {
        blocks: [
            sourceBlock,
            proxy,
            {
                customType: "BABYLON.SystemBlock",
                id: 3,
                inputs: [
                    {
                        name: role === "particle flow" ? "particle" : role === "system flow" ? "onStart" : "texture",
                        targetBlockId: 2,
                        targetConnectionName: "output",
                    },
                ],
            },
        ],
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("Phase 3C graph plumbing", () => {
    it("accepts Particle scope only on a particle-only domain", async () => {
        const normalized = await normalizeNodeParticleGraph(parseNodeParticleSource(localGraph(0, true, false)));
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, normalized);

        expect(normalized._isGraphPlumbingNormalized).toBe(true);
        expect(set.systems[0]!.buffer._columns.size).toBe(6);
    });

    it.each([
        ["system-only", false, true],
        ["shared particle and system", true, true],
    ])("rejects Particle scope on a %s domain", async (_name, useParticle, useSystem) => {
        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(localGraph(0, useParticle, useSystem)))).rejects.toThrow(
            "NodeParticle: ParticleLocalVariableBlock 2 Particle scope requires particle-only evaluation"
        );
    });

    it.each([
        ["particle", true, false, 1],
        ["system", false, true, 1],
        ["shared", true, true, 1],
        ["missing scope", false, true, undefined],
    ] as Array<[string, boolean, boolean, unknown]>)("accepts Loop scope on the %s domain", async (_name, useParticle, useSystem, scope) => {
        const normalized = await normalizeNodeParticleGraph(parseNodeParticleSource(localGraph(scope, useParticle, useSystem)));
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, normalized);

        expect(set.systems).toHaveLength(1);
        expect(set.systems[0]!.buffer._columns.size).toBe(0);
    });

    it.each([
        ["ParticleElbowBlock", undefined],
        ["ParticleDebugBlock", 37],
    ] as const)("compiles away %s on an NpeValue route", async (className, stackSize) => {
        const source = passThroughSource(className, stackSize);
        const snapshot = structuredClone(source);
        const parsed = parseNodeParticleSource(source);
        const normalized = await normalizeNodeParticleGraph(parsed);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, normalized);

        expect(normalized.blocks.get(3)!.inputs[0]).toMatchObject({ targetBlockId: 1, targetConnectionName: "output" });
        expect(normalized.blocks.get(2)).toBe(parsed.blocks.get(2));
        expect(set.systems[0]!.targetStopDuration).toBe(7);
        expect(source).toEqual(snapshot);
        expect(await normalizeNodeParticleGraph(normalized)).toBe(normalized);
    });

    it("routes every opaque connection role through Elbow", async () => {
        const source: GraphSource = {
            blocks: [
                { customType: "BABYLON.CreateParticleBlock", id: 1, inputs: [] },
                { customType: "BABYLON.ParticleTextureSourceBlock", id: 2, inputs: [] },
                { customType: "BABYLON.ParticleInputBlock", id: 3, type: 0x0002, value: 1, inputs: [] },
                { customType: "BABYLON.ParticleElbowBlock", id: 10, inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "particle" }] },
                { customType: "BABYLON.ParticleElbowBlock", id: 11, inputs: [{ name: "input", targetBlockId: 3, targetConnectionName: "output" }] },
                { customType: "BABYLON.ParticleElbowBlock", id: 12, inputs: [{ name: "input", targetBlockId: 2, targetConnectionName: "texture" }] },
                { customType: "BABYLON.ParticleElbowBlock", id: 13, inputs: [{ name: "input", targetBlockId: 3, targetConnectionName: "output" }] },
                { customType: "BABYLON.ParticleGradientBlock", id: 20, inputs: [{ name: "value0", targetBlockId: 13, targetConnectionName: "output" }] },
                {
                    customType: "BABYLON.SystemBlock",
                    id: 30,
                    inputs: [
                        { name: "particle", targetBlockId: 10, targetConnectionName: "output" },
                        { name: "onStart", targetBlockId: 11, targetConnectionName: "output" },
                        { name: "texture", targetBlockId: 12, targetConnectionName: "output" },
                        { name: "targetStopDuration", targetBlockId: 20, targetConnectionName: "output" },
                    ],
                },
            ],
        };
        const normalized = await normalizeNodeParticleGraph(parseNodeParticleSource(source));
        const input = (blockId: number, name: string) => normalized.blocks.get(blockId)!.inputs.find((candidate) => candidate.name === name)!;

        expect(input(30, "particle")).toMatchObject({ targetBlockId: 1, targetConnectionName: "particle" });
        expect(input(30, "onStart")).toMatchObject({ targetBlockId: 3, targetConnectionName: "output" });
        expect(input(30, "texture")).toMatchObject({ targetBlockId: 2, targetConnectionName: "texture" });
        expect(input(20, "value0")).toMatchObject({ targetBlockId: 3, targetConnectionName: "output" });
    });

    it.each([
        ["ParticleElbowBlock", 10, "elbowValue"],
        ["ParticleDebugBlock", 11, "debugValue"],
        ["ParticleLocalVariableBlock", 12, "localValue"],
    ] as const)("rejects a non-output reference to %s", async (className, id, badName) => {
        const source: GraphSource = {
            blocks: [
                { customType: "BABYLON.ParticleInputBlock", id: 1, type: 0x0002, value: 1, inputs: [] },
                {
                    customType: `BABYLON.${className}`,
                    id,
                    ...(className === "ParticleLocalVariableBlock" ? { scope: 1 } : {}),
                    inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
                },
                { customType: "BABYLON.SystemBlock", id: 20, inputs: [{ name: "targetStopDuration", targetBlockId: id, targetConnectionName: badName }] },
            ],
        };

        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(source))).rejects.toThrowError(
            new Error(`NodeParticle: ${className} ${id} does not expose output "${badName}"`)
        );
    });

    it.each(["ParticleDebugBlock", "ParticleLocalVariableBlock"] as const)("rejects every unsupported connection role for %s", async (className) => {
        for (const role of ["particle flow", "system flow", "texture", "gradient metadata"]) {
            await expect(normalizeNodeParticleGraph(parseNodeParticleSource(unsupportedRoleSource(className, role)))).rejects.toThrow(
                `NodeParticle: ${className} 2 does not support ${role} connections`
            );
        }
    });

    it.each(["ParticleElbowBlock", "ParticleDebugBlock", "ParticleLocalVariableBlock"] as const)("rejects a disconnected reachable %s", async (className) => {
        const source = passThroughSource(className === "ParticleLocalVariableBlock" ? "ParticleDebugBlock" : className);
        source.blocks[1] = { customType: `BABYLON.${className}`, id: 2, scope: 1, inputs: [{ name: "input", targetBlockId: 1 }] };

        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(source))).rejects.toThrow(`NodeParticle: ${className} 2 input is not connected`);
    });

    it("reports one deterministic cycle across Elbow, Debug, and Teleport", async () => {
        const source: GraphSource = {
            blocks: [
                { customType: "BABYLON.ParticleElbowBlock", id: 2, inputs: [{ name: "input", targetBlockId: 3, targetConnectionName: "output" }] },
                { customType: "BABYLON.ParticleDebugBlock", id: 3, inputs: [{ name: "input", targetBlockId: 4, targetConnectionName: "output" }] },
                { customType: "BABYLON.ParticleTeleportOutBlock", id: 4, entryPoint: 5, inputs: [] },
                { customType: "BABYLON.ParticleTeleportInBlock", id: 5, inputs: [{ name: "input", targetBlockId: 2, targetConnectionName: "output" }] },
                { customType: "BABYLON.SystemBlock", id: 6, inputs: [{ name: "targetStopDuration", targetBlockId: 2, targetConnectionName: "output" }] },
            ],
        };

        await expect(normalizeNodeParticleGraph(parseNodeParticleSource(source))).rejects.toThrow("NodeParticle: graph plumbing cycle 2 -> 3 -> 4 -> 5 -> 2");
    });

    it("marks detached malformed Phase 3C candidates without diagnosing or replacing parsed storage", async () => {
        const graph = parseNodeParticleSource({
            blocks: [
                { customType: "BABYLON.SystemBlock", id: 1, inputs: [] },
                { customType: "BABYLON.ParticleElbowBlock", id: 2, inputs: [] },
                { customType: "BABYLON.ParticleDebugBlock", id: 3, inputs: [] },
                { customType: "BABYLON.ParticleLocalVariableBlock", id: 4, scope: 0, inputs: [] },
            ],
        });
        const normalized = await normalizeNodeParticleGraph(graph);

        expect(normalized).not.toBe(graph);
        expect(normalized.blocks).toBe(graph.blocks);
        expect(normalized.systemBlockIds).toBe(graph.systemBlockIds);
        expect(normalized._isGraphPlumbingNormalized).toBe(true);
    });

    it.each([
        ["default", buildNodeParticleSet],
        ["flow-map", buildNodeParticleSetWithFlowMaps],
        ["noise", buildNodeParticleSetWithNoiseTextures],
        ["combined texture-update", buildNodeParticleSetWithTextureUpdates],
        ["blend", buildNodeParticleSetWithBlendModes],
    ] as const)("builds one normalized LocalVariable graph through the %s family", async (_name, builder) => {
        const graph = await normalizeNodeParticleGraph(parseNodeParticleSource(localGraph(1, false, true)));
        const set = await builder({} as EngineContext, {} as SceneContext, graph);

        expect(set.systems[0]!.targetStopDuration).toBe(7);
    });

    it("builds a normalized LocalVariable graph with an emitter provider", async () => {
        const graph = await normalizeNodeParticleGraph(parseNodeParticleSource(localGraph(1, false, true)));
        const set = await buildNodeParticleSetWithEmitterProvider({} as EngineContext, {} as SceneContext, graph, () => mat4Identity());

        expect(set.systems[0]!.targetStopDuration).toBe(7);
    });

    it("normalizes LocalVariable through inline and fetched snippet boundaries", async () => {
        const inline = await parseNodeParticleSetFromSnippet({} as EngineContext, {} as SceneContext, "", { json: localGraph(1, false, true) });
        const source = localGraph(1, false, true);
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ jsonPayload: JSON.stringify({ nodeParticle: JSON.stringify(source) }) }),
        }));
        vi.stubGlobal("fetch", fetchMock);
        const fetched = await parseNodeParticleSetFromSnippet({} as EngineContext, {} as SceneContext, "LOCAL#1", { snippetServer: "https://snippets.invalid" });

        expect(inline._graph._isGraphPlumbingNormalized).toBe(true);
        expect(fetched._graph._isGraphPlumbingNormalized).toBe(true);
        expect(inline.systems[0]!.targetStopDuration).toBe(7);
        expect(fetched.systems[0]!.targetStopDuration).toBe(7);
    });

    it("keeps direct pass-through omission unsupported while the helper enables it", async () => {
        const graph = parseNodeParticleSource(passThroughSource("ParticleElbowBlock"));
        await expect(buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph)).rejects.toThrow('NodeParticle: unsupported value block "ParticleElbowBlock"');

        const normalized = await normalizeNodeParticleGraph(graph);
        expect((await buildNodeParticleSet({} as EngineContext, {} as SceneContext, normalized)).systems[0]!.targetStopDuration).toBe(7);
    });
});
