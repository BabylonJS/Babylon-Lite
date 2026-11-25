import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCENE262_NPE_JSON } from "../../../lab/lite/src/shared/scene262-npe";
import changeEmitRateGraph from "./fixtures/change-emit-rate-npe.json";
import changeEmitRateTruth from "./fixtures/change-emit-rate-states.json";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { parseNodeParticleSetFromSnippet } from "../../../packages/babylon-lite/src/particle/node/node-particle";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { animateParticleSystem, startParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

const blockEvents = vi.hoisted(() => [] as string[]);
// While `hold` is set, each block load stays pending until the test releases it, exposing load concurrency.
const loadGate = vi.hoisted(() => ({ hold: false, held: new Map<string, () => void>(), resolved: [] as string[] }));
vi.mock("../../../packages/babylon-lite/src/particle/node/npe-manifest.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../packages/babylon-lite/src/particle/node/npe-manifest")>();
    return {
        loadNpeBlock: async (className: string) => {
            blockEvents.push(`load ${className}`);
            if (loadGate.hold) {
                await new Promise<void>((release) => loadGate.held.set(className, release));
            }
            const evaluator = await actual.loadNpeBlock(className);
            loadGate.resolved.push(className);
            return {
                build: (...args: Parameters<typeof evaluator.build>) => {
                    blockEvents.push(`build ${className}`);
                    return evaluator.build(...args);
                },
            };
        },
    };
});

interface MutableGraphSource {
    blocks: Array<{
        customType: string;
        inputs: Array<{ name: string; targetBlockId?: number; targetConnectionName?: string | null }>;
    }>;
}

function systemEmitRateInput(source: MutableGraphSource): MutableGraphSource["blocks"][number]["inputs"][number] {
    const system = source.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
    return system.inputs.find((input) => input.name === "emitRate")!;
}

function releaseHeldLoads(classNames: readonly string[]): void {
    for (const className of classNames) {
        loadGate.held.get(className)?.();
        loadGate.held.delete(className);
    }
}

afterEach(() => {
    loadGate.hold = false;
    releaseHeldLoads([...loadGate.held.keys()]);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("NPE build reachability", () => {
    it("builds typed-array systems through the canonical inline-JSON API", async () => {
        const set = await parseNodeParticleSetFromSnippet({} as EngineContext, {} as SceneContext, "", {
            json: SCENE262_NPE_JSON,
            emitter: { x: 0, y: 0, z: 0 },
        });

        expect(set.systems).toHaveLength(1);
        expect(set.systems[0]!.buffer.posX).toBeInstanceOf(Float32Array);
        expect(set.systems[0]!.name).toBe(SCENE262_NPE_JSON.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!.name);
    });

    it("starts every reachable block load concurrently and builds only after all loads resolve", async () => {
        blockEvents.length = 0;
        loadGate.resolved.length = 0;
        loadGate.hold = true;
        const built = buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(SCENE262_NPE_JSON), { emitter: { x: 0, y: 0, z: 0 } });

        // A sequential loader would stall here with a single pending load.
        await vi.waitFor(() => expect(loadGate.held.size).toBeGreaterThan(0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const started = [...loadGate.held.keys()];
        expect(started.length).toBeGreaterThan(1);
        const loads = blockEvents.filter((event) => event.startsWith("load "));
        expect(loads).toHaveLength(started.length);

        const [last, ...rest] = started;
        releaseHeldLoads(rest);
        await vi.waitFor(() => expect(loadGate.resolved).toHaveLength(rest.length));
        expect(blockEvents.filter((event) => event.startsWith("build "))).toEqual([]);

        loadGate.hold = false;
        releaseHeldLoads([last!]);
        await built;
        const builtClasses = blockEvents.filter((event) => event.startsWith("build ")).map((event) => event.slice("build ".length));
        expect(builtClasses.length).toBeGreaterThan(0);
        expect(new Set(builtClasses)).toEqual(new Set(started));
    });

    it("emits from the emitter position passed at call time when the caller mutates its vector during block loading", async () => {
        loadGate.hold = true;
        const scratch = { x: 1000, y: 0, z: 0 };
        const built = buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(SCENE262_NPE_JSON), { emitter: scratch });
        await vi.waitFor(() => expect(loadGate.held.size).toBeGreaterThan(0));
        scratch.x = -1000;
        loadGate.hold = false;
        releaseHeldLoads([...loadGate.held.keys()]);

        const system = (await built).systems[0]!;
        startParticleSystem(system);
        for (let frame = 0; frame < 600 && system.buffer.alive === 0; frame++) {
            animateParticleSystem(system, 1);
        }
        const alive = system.buffer.alive;
        expect(alive).toBeGreaterThan(0);
        expect(Math.min(...system.buffer.posX.subarray(0, alive))).toBeGreaterThan(500);
    });

    it.each(["", undefined])("omits an absent SystemBlock name (%s)", async (name) => {
        const graph = parseNodeParticleSource({ blocks: [{ customType: "BABYLON.SystemBlock", id: 1, name }] });
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph);
        expect(Object.hasOwn(set.systems[0]!, "name")).toBe(false);
    });

    it("uses the Babylon NPE update-speed default when it is not serialized", async () => {
        const source = structuredClone(SCENE262_NPE_JSON) as { blocks: Array<Record<string, unknown>> };
        const system = source.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
        delete system.updateSpeed;

        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(source));

        expect(set.systems[0]!.updateSpeed).toBe(0.0167);
    });

    it.each([
        { name: "loads an embedded texture with explicit invertY false", url: "", invertY: false, expectedUrl: "embedded", expectedFlipY: true },
        { name: "loads an embedded texture with explicit invertY true", url: "", invertY: true, expectedUrl: "embedded", expectedFlipY: false },
        { name: "treats an omitted invertY as false like Babylon.js deserialization", url: "", invertY: undefined, expectedUrl: "embedded", expectedFlipY: true },
        {
            name: "prefers embedded data for dual-source input like Babylon.js deserialization",
            url: "https://assets.example/particle.png",
            invertY: undefined,
            expectedUrl: "embedded",
            expectedFlipY: true,
        },
    ])("$name", async ({ url, invertY, expectedUrl, expectedFlipY }) => {
        const textureDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => ({}) }));
        vi.stubGlobal("fetch", fetchMock);
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
        );
        const gpuTexture = { createView: vi.fn(() => ({})), destroy: vi.fn() };
        const copyExternalImageToTexture = vi.fn();
        const engine = {
            _device: {
                createTexture: vi.fn(() => gpuTexture),
                createSampler: vi.fn(() => ({})),
                queue: { copyExternalImageToTexture },
            },
        } as never;
        const graph = parseNodeParticleSource({
            blocks: [
                {
                    customType: "BABYLON.SystemBlock",
                    id: 2,
                    inputs: [{ name: "texture", targetBlockId: 1, targetConnectionName: "texture" }],
                },
                {
                    customType: "BABYLON.ParticleTextureSourceBlock",
                    id: 1,
                    url,
                    serializedCachedData: true,
                    textureDataUrl,
                    ...(invertY === undefined ? {} : { invertY }),
                    inputs: [],
                },
            ],
        });

        const set = await buildNodeParticleSet(engine, {} as SceneContext, graph);

        expect(fetchMock).toHaveBeenCalledWith(expectedUrl === "url" ? url : textureDataUrl);
        expect(copyExternalImageToTexture).toHaveBeenCalledWith(expect.objectContaining({ flipY: expectedFlipY }), expect.anything(), expect.anything());
        expect(set.systems[0]!.texture).toMatchObject({ width: 1, height: 1 });
    });

    it.each([
        {
            name: "rejects the build when the texture loader module fails to load",
            loaderModule: () => {
                throw new Error("loader chunk failed");
            },
            outcome: new Error("loader chunk failed"),
        },
        {
            name: "tolerates a failed texture image load",
            loaderModule: () => ({ loadTexture2D: () => Promise.reject(new Error("image failed")) }),
            outcome: null,
        },
    ])("$name", async ({ loaderModule, outcome }) => {
        vi.doMock("../../../packages/babylon-lite/src/texture/texture-2d.js", loaderModule);
        vi.resetModules();
        try {
            const graph = parseNodeParticleSource({
                blocks: [
                    { customType: "BABYLON.ParticleTextureSourceBlock", id: 1, url: "https://assets.example/particle.png", inputs: [] },
                    { customType: "BABYLON.SystemBlock", id: 2, inputs: [{ name: "texture", targetBlockId: 1, targetConnectionName: "texture" }] },
                ],
            });

            // The build either rejects with the loader error, which Vitest wraps as the cause of a throwing mock
            // factory, or resolves with the system texture left unset.
            const settled = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph).then(
                (set) => set.systems[0]!.texture,
                (error: Error) => error.cause ?? error
            );
            expect(settled).toEqual(outcome);
        } finally {
            vi.doUnmock("../../../packages/babylon-lite/src/texture/texture-2d.js");
            vi.resetModules();
        }
    });

    it("observes a failed texture loader import when a later system rejects the build first", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        let loaderImports = 0;
        vi.doMock("../../../packages/babylon-lite/src/texture/texture-2d.js", () => {
            loaderImports++;
            throw new Error("loader chunk failed");
        });
        vi.resetModules();
        try {
            const graph = parseNodeParticleSource({
                blocks: [
                    { customType: "BABYLON.ParticleTextureSourceBlock", id: 1, url: "https://assets.example/particle.png", inputs: [] },
                    { customType: "BABYLON.SystemBlock", id: 2, inputs: [{ name: "texture", targetBlockId: 1, targetConnectionName: "texture" }] },
                    { customType: "BABYLON.SystemBlock", id: 3, inputs: [{ name: "emitRate", targetBlockId: 1, targetConnectionName: "texture" }] },
                ],
            });

            await expect(buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph)).rejects.toThrow("SystemBlock.emitRate");
            // Wait for the orphaned loader import to settle, then for the next macrotask, by which Node has reported
            // any rejection that nothing observed.
            await vi.dynamicImportSettled();
            await new Promise((resolve) => setImmediate(resolve));
            expect(loaderImports).toBe(1);
            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
            vi.doUnmock("../../../packages/babylon-lite/src/texture/texture-2d.js");
            vi.resetModules();
        }
    });

    it.each([
        { name: "rejects a texture wired into a value input", blockId: 4, input: "size", source: [45, "texture"], rejected: "CreateParticleBlock.size" },
        { name: "rejects a value wired into a texture input", blockId: 44, input: "texture", source: [9, "output"], rejected: "SystemBlock.texture" },
    ] as const)("$name", async ({ blockId, input, source: [targetBlockId, targetConnectionName], rejected }) => {
        const source = structuredClone(SCENE262_NPE_JSON) as { blocks: Array<{ id: number; inputs: Array<Record<string, unknown>> }> };
        const port = source.blocks.find((block) => block.id === blockId)!.inputs.find((candidate) => candidate.name === input)!;
        port.targetBlockId = targetBlockId;
        port.targetConnectionName = targetConnectionName;

        await expect(buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(source))).rejects.toThrow(rejected);
    });

    it("ignores detached unsupported and OncePerParticle blocks", async () => {
        const source = JSON.parse(JSON.stringify(SCENE262_NPE_JSON)) as { blocks: Array<Record<string, unknown>> };
        source.blocks.push(
            { customType: "BABYLON.UnsupportedDetachedBlock", id: 10001, name: "detached unsupported", inputs: [], outputs: [] },
            { customType: "BABYLON.ParticleRandomBlock", id: 10002, name: "detached once", lockMode: 3, inputs: [], outputs: [{ name: "output" }] }
        );

        const graph = parseNodeParticleSource(source);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        expect(set.systems).toHaveLength(1);
        expect([...set.systems[0]!.buffer._columns.keys()].some((name) => name.startsWith("random.10002."))).toBe(false);
    });

    it("treats a port without a target connection name as unconnected", async () => {
        const source = structuredClone(changeEmitRateGraph) as MutableGraphSource;
        systemEmitRateInput(source).targetConnectionName = null;

        const graph = parseNodeParticleSource(source);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        const system = set.systems[0]!;

        expect(system.emitRate).toBe(10);
        expect(system._emitRateGetter).toBeUndefined();
    });

    it("does not evaluate a connected emit-rate graph during build", async () => {
        const source = structuredClone(changeEmitRateGraph) as MutableGraphSource;
        const emitRate = systemEmitRateInput(source);
        emitRate.targetBlockId = 8;
        emitRate.targetConnectionName = "output";

        const previousRandom = Math.random;
        let randomCalls = 0;
        Math.random = () => {
            randomCalls++;
            return 0.5;
        };
        try {
            const graph = parseNodeParticleSource(source);
            const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
            expect(set.systems[0]!._emitRateGetter).toBeDefined();
        } finally {
            Math.random = previousRandom;
        }

        expect(randomCalls).toBe(0);
    });

    it("re-evaluates a connected emit-rate graph from system time", async () => {
        const truth = changeEmitRateTruth as { N: number; count: number };
        const graph = parseNodeParticleSource(changeEmitRateGraph);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        const system = set.systems[0]!;
        expect(system._emitRateGetter).toBeDefined();

        const previousRandom = Math.random;
        let seed = 1;
        Math.random = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };
        try {
            startParticleSystem(system);
            for (let step = 0; step < truth.N; step++) {
                animateParticleSystem(system, 1);
            }
        } finally {
            Math.random = previousRandom;
        }

        expect(system.buffer.alive).toBe(truth.count);
    });
});

describe("NPE block manifest", () => {
    it("keeps exactly the classic converter's default classes in the base table", () => {
        const manifestSource = readFileSync(resolve(__dirname, "../../../packages/babylon-lite/src/particle/node/npe-manifest.ts"), "utf8");
        const baseClasses = [...manifestSource.matchAll(/^\s+(\w+): \(\) => import\(/gm)].map((match) => match[1]).sort();
        // Scene 262 is a box-emitter ParticleSystem without gradients, converted by Babylon.js ConvertToNodeParticleSystemSetAsync.
        const converterClasses = [...new Set(SCENE262_NPE_JSON.blocks.map((block) => block.customType.replace(/^BABYLON\./, "")))].sort();

        expect(converterClasses).toHaveLength(11);
        expect(baseClasses).toEqual(converterClasses);
    });
});
