import { afterEach, describe, expect, it, vi } from "vitest";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { _resetMatrixAllocatorForTests, _setHpmAllocator } from "../../../packages/babylon-lite/src/math/_matrix-allocator";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import { createParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import { registerNodeParticleSet } from "../../../packages/babylon-lite/src/particle/particle-scene";
import { cpuTextureSourceBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/cpu-texture-source-block";
import { updateFlowMapBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/update-flow-map-block";
import { buildNodeParticleSetWithFlowMaps } from "../../../packages/babylon-lite/src/particle/node/npe-flow-map";
import type { NodeParticleSet, NpeBuildContext } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { loadNpeTextureContent } from "../../../packages/babylon-lite/src/particle/node/npe-texture-content";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { NpeGetter, NpeTextureContent, NpeTextureValue } from "../../../packages/babylon-lite/src/particle/node/npe-value";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

function flowMap(data: number[], width = 1, height = 1): NpeTextureContent {
    return { width, height, data: new Uint8ClampedArray(data) };
}

function createFlowScene(
    camera: ReturnType<typeof createArcRotateCamera> | null = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 }),
    width = 100,
    height = 100
): SceneContext {
    return {
        camera,
        surface: { canvas: { width, height } },
        _beforeRender: [],
        _deferredBuilders: [],
    } as unknown as SceneContext;
}

async function attachFlowMap(
    system: ReturnType<typeof createParticleSystem>,
    map: NpeTextureContent,
    strengthGetter: () => number,
    scene = createFlowScene(),
    source: NpeTextureValue = { url: "flow.png", invertY: false, _content: Promise.resolve(map) }
): Promise<void> {
    const promises: Promise<void>[] = [];
    const ctx = {
        state: { system, buffer: system.buffer, scene },
        input(_block: ParsedParticleBlock, name: string): NpeGetter {
            return name === "flowMap" ? ((() => source) as unknown as NpeGetter) : strengthGetter;
        },
        addBuildPromise(promise: Promise<void>) {
            promises.push(promise);
        },
    } as unknown as NpeBuildContext;
    const block = { id: 1, className: "UpdateFlowMapBlock", name: "flow", inputs: [], serialized: {} } as ParsedParticleBlock;
    updateFlowMapBlock.build(block, ctx);
    await Promise.all(promises);
}

afterEach(() => {
    vi.unstubAllGlobals();
    _resetMatrixAllocatorForTests();
});

describe("NPE UpdateFlowMapBlock", () => {
    it("samples projected RGBA flow with alpha-weighted strength", async () => {
        const map = flowMap([255, 128, 0, 128]);
        const system = createParticleSystem(1);
        const buffer = system.buffer;
        buffer.dirX[0] = 1;
        const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
        await attachFlowMap(system, map, () => 2, createFlowScene(camera));
        system._scaledStep = 1;

        system.updateSteps[0]!(0);

        const scale = 2 * (128 / 255);
        expect(buffer.dirX[0]).toBeCloseTo(1 + scale, 6);
        expect(buffer.dirY[0]).toBeCloseTo((1 / 255) * scale, 6);
        expect(buffer.dirZ[0]).toBeCloseTo(-scale, 6);
    });

    it("samples a bottom-row texel with the full row stride", async () => {
        const map = flowMap([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 128, 128, 255], 2, 2);
        const system = createParticleSystem(1);
        system.buffer.posY[0] = -1;
        const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
        await attachFlowMap(system, map, () => 1, createFlowScene(camera));
        system._scaledStep = 1;

        system.updateSteps[0]!(0);

        expect(system.buffer.dirX[0]).toBeCloseTo(1, 6);
        expect(system.buffer.dirY[0]).toBeCloseTo(1 / 255, 6);
        expect(system.buffer.dirZ[0]).toBeCloseTo(1 / 255, 6);
    });

    it("allocates its prepared matrix through the HPM policy", async () => {
        const allocations: Float64Array[] = [];
        _setHpmAllocator(() => {
            const matrix = new Float64Array(16);
            allocations.push(matrix);
            return matrix as unknown as Mat4;
        });

        await attachFlowMap(createParticleSystem(1), flowMap([255, 128, 128, 255]), () => 1, createFlowScene(null));

        expect(allocations).toHaveLength(1);
        expect(allocations[0]).toBeInstanceOf(Float64Array);
    });

    it("rejects samples outside the screen and ignores transparent pixels", async () => {
        const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
        const transparent = createParticleSystem(1);
        transparent.buffer.dirX[0] = 3;
        await attachFlowMap(transparent, flowMap([255, 255, 255, 0]), () => 4, createFlowScene(camera));
        transparent._scaledStep = 1;
        transparent.updateSteps[0]!(0);
        expect(transparent.buffer.dirX[0]).toBe(3);

        const outside = createParticleSystem(1);
        outside.buffer.posX[0] = 1000;
        outside.buffer.dirX[0] = 3;
        let strengthCalls = 0;
        await attachFlowMap(
            outside,
            flowMap([255, 255, 255, 255]),
            () => {
                strengthCalls++;
                return 4;
            },
            createFlowScene(camera)
        );
        outside._scaledStep = 1;
        outside.updateSteps[0]!(0);
        expect(outside.buffer.dirX[0]).toBe(3);
        expect(strengthCalls).toBe(1);
    });

    it("evaluates strength per particle and applies the current scaled step", async () => {
        const system = createParticleSystem(1);
        const map: NpeTextureContent = { width: 1, height: 1, data: new Uint8ClampedArray([255, 128, 128, 255]) };
        const camera = createArcRotateCamera(0, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
        let strength = 8;
        let strengthCalls = 0;
        await attachFlowMap(
            system,
            map,
            () => {
                strengthCalls++;
                return strength;
            },
            createFlowScene(camera)
        );
        camera._vpCache.fill(0);
        system._scaledStep = 0.25;
        system.updateSteps[0]!(0);
        strength = 4;
        system._scaledStep = 0.5;
        system.updateSteps[0]!(0);

        expect(system.buffer.dirX[0]).toBeCloseTo(4, 6);
        expect(strengthCalls).toBe(2);
    });

    it("prepares after camera controls and before live simulation on an already-built scene", async () => {
        const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
        const scene = createFlowScene(camera);
        scene._built = true;
        scene._disposables = [];
        scene._pickSources = [];
        let cameraUpdated = false;
        let cameraWasUpdatedAtSimulation = false;
        scene._beforeRender.push(() => {
            cameraUpdated = true;
        });

        const system = createParticleSystem(1);
        system.texture = { width: 1, height: 1 } as Texture2D;
        system.emitRate = 0;
        system.buffer.alive = 1;
        system.buffer.lifeTime[0] = 10;
        await attachFlowMap(
            system,
            flowMap([255, 128, 128, 255]),
            () => {
                cameraWasUpdatedAtSimulation = cameraUpdated;
                return 1;
            },
            scene
        );

        registerNodeParticleSet(scene, { systems: [system] } as NodeParticleSet);

        for (const callback of scene._beforeRender) {
            callback(16);
        }

        expect(cameraWasUpdatedAtSimulation).toBe(true);
        expect(scene._deferredBuilders).toHaveLength(1);
    });

    it("builds registry and texture wiring through a parsed graph", async () => {
        const data = new Uint8ClampedArray([255, 128, 128, 255]);
        const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => ({}) }));
        vi.stubGlobal("fetch", fetchMock);
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
        );
        vi.stubGlobal(
            "OffscreenCanvas",
            vi.fn(function (this: { getContext: () => unknown }) {
                this.getContext = () => ({ setTransform: vi.fn(), drawImage: vi.fn(), getImageData: () => ({ data }) });
            })
        );
        const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
        const scene = createFlowScene(camera, Number.NaN, Number.POSITIVE_INFINITY);
        const graph = parseNodeParticleSource({
            blocks: [
                {
                    customType: "BABYLON.SystemBlock",
                    id: 4,
                    capacity: 2,
                    inputs: [
                        { name: "particle", targetBlockId: 3, targetConnectionName: "output" },
                        { name: "texture", targetBlockId: 2, targetConnectionName: "texture" },
                    ],
                },
                {
                    customType: "BABYLON.UpdateFlowMapBlock",
                    id: 3,
                    inputs: [
                        { name: "particle", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "flowMap", targetBlockId: 2, targetConnectionName: "texture" },
                        { name: "strength", valueType: "number", value: 2 },
                    ],
                },
                { customType: "BABYLON.CreateParticleBlock", id: 1, inputs: [] },
                {
                    customType: "BABYLON.ParticleTextureSourceBlock",
                    id: 2,
                    url: "billboard.png",
                    textureDataUrl: "data:image/png;base64,AA==",
                    invertY: false,
                    inputs: [],
                },
            ],
        });
        const originalFlowInput = graph.blocks.get(3)!.inputs.find((input) => input.name === "flowMap")!;
        const set = await buildNodeParticleSetWithFlowMaps({ _device: {} } as never, scene, graph);
        const system = set.systems[0]!;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(originalFlowInput.targetBlockId).toBe(2);
        expect(graph.blocks.get(3)!.inputs).toContain(originalFlowInput);
        const animationStep = vi.fn();
        scene._beforeRender.push(animationStep);
        await Promise.all(scene._deferredBuilders.splice(0).map((builder) => builder()));
        expect(scene._beforeRender[1]).toBe(animationStep);
        camera._vpCache.fill(0);
        scene.surface.canvas.width = 200;
        scene.surface.canvas.height = 100;
        scene._beforeRender[0]!(16);
        system._scaledStep = 0.5;

        system.updateSteps[0]!(0);
        system.updateSteps[0]!(1);

        expect(system.buffer.dirX[0]).toBeCloseTo(1, 6);
        expect(system.buffer.dirX[1]).toBeCloseTo(1, 6);
    });

    it("evaluates connected strength without changing particle angle", async () => {
        const data = new Uint8ClampedArray([255, 128, 128, 255]);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: true, blob: async () => ({}) }))
        );
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
        );
        vi.stubGlobal(
            "OffscreenCanvas",
            vi.fn(function (this: { getContext: () => unknown }) {
                this.getContext = () => ({ setTransform: vi.fn(), drawImage: vi.fn(), getImageData: () => ({ data }) });
            })
        );
        const scene = createFlowScene();
        const graph = parseNodeParticleSource({
            blocks: [
                { customType: "BABYLON.SystemBlock", id: 5, capacity: 1, inputs: [{ name: "particle", targetBlockId: 3, targetConnectionName: "output" }] },
                {
                    customType: "BABYLON.UpdateFlowMapBlock",
                    id: 3,
                    inputs: [
                        { name: "particle", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "flowMap", targetBlockId: 2, targetConnectionName: "texture" },
                        { name: "strength", targetBlockId: 4, targetConnectionName: "output" },
                    ],
                },
                { customType: "BABYLON.CreateParticleBlock", id: 1, inputs: [] },
                { customType: "BABYLON.ParticleTextureSourceBlock", id: 2, textureDataUrl: "data:image/png;base64,AA==", invertY: false, inputs: [] },
                { customType: "BABYLON.ParticleInputBlock", id: 4, type: 2, value: 2, inputs: [] },
            ],
        });
        const set = await buildNodeParticleSetWithFlowMaps({ _device: {} } as never, scene, graph);
        const system = set.systems[0]!;
        system.buffer.angle[0] = 7;
        system._scaledStep = 1;

        system.updateSteps[0]!(0);

        expect(system.buffer.angle[0]).toBe(7);
        expect(system.buffer.dirX[0]).toBeCloseTo(2, 6);
    });

    it("caches converter-style data URL decoding and honors invertY", async () => {
        const data = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
        const setTransform = vi.fn();
        const drawImage = vi.fn();
        const getImageData = vi.fn(() => ({ data }));
        const context = { setTransform, drawImage, getImageData };
        const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => ({}) }));
        const close = vi.fn();
        const createImageBitmapMock = vi.fn(async () => ({ width: 2, height: 1, close }));
        const OffscreenCanvasMock = vi.fn(function (this: { getContext: () => typeof context }) {
            this.getContext = () => context;
        });
        vi.stubGlobal("fetch", fetchMock);
        vi.stubGlobal("createImageBitmap", createImageBitmapMock);
        vi.stubGlobal("OffscreenCanvas", OffscreenCanvasMock);
        const source = { url: "data:image/png;base64,AA==", invertY: true } as NpeTextureValue;

        const first = loadNpeTextureContent(source);
        const second = loadNpeTextureContent(source);

        expect(second).toBe(first);
        await expect(first).resolves.toEqual({ width: 2, height: 1, data });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(createImageBitmapMock).toHaveBeenCalledWith(expect.anything(), {
            premultiplyAlpha: "none",
            colorSpaceConversion: "none",
        });
        expect(setTransform).toHaveBeenCalledWith(1, 0, 0, -1, 0, 1);
        expect(drawImage).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });

    it("prefers serialized textureDataUrl for a flow-map texture", () => {
        const block = {
            id: 2,
            className: "ParticleTextureSourceBlock",
            name: "flow texture",
            inputs: [],
            serialized: { url: "fallback.png", textureDataUrl: "data:image/png;base64,AA==", invertY: true },
        } as ParsedParticleBlock;
        let output: NpeGetter | undefined;
        const ctx = {
            state: { textureBaseUrl: "https://example.test/textures/" },
            setOutput(_blockId: number, _name: string, getter: NpeGetter) {
                output = getter;
            },
        } as unknown as NpeBuildContext;

        cpuTextureSourceBlock.build(block, ctx);

        expect(output?.(0) as unknown as NpeTextureValue).toMatchObject({ url: "data:image/png;base64,AA==", invertY: true });
    });

    it("rejects unsupported texture URL schemes", () => {
        const block = {
            id: 2,
            className: "ParticleTextureSourceBlock",
            name: "flow texture",
            inputs: [],
            serialized: { url: "javascript:alert(1)", invertY: false },
        } as ParsedParticleBlock;
        let output: NpeGetter | undefined;
        const ctx = {
            state: {},
            setOutput(_blockId: number, _name: string, getter: NpeGetter) {
                output = getter;
            },
        } as unknown as NpeBuildContext;

        cpuTextureSourceBlock.build(block, ctx);

        expect((output?.(0) as unknown as NpeTextureValue).url).toBe("");
    });
});
