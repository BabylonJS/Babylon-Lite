import { afterEach, describe, expect, it, vi } from "vitest";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { createNullEngine } from "../../../packages/babylon-lite/src/engine/null-engine";
import { _appendTask } from "../../../packages/babylon-lite/src/frame-graph/frame-graph";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";
import { _resetMatrixAllocatorForTests, _setHpmAllocator } from "../../../packages/babylon-lite/src/math/_matrix-allocator";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import { animateParticleSystem, createParticleSystem, startParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import { registerNodeParticleSet } from "../../../packages/babylon-lite/src/particle/particle-scene";
import { npeBlock as particleTextureSourceBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/texture-source-block";
import { npeBlock as updateFlowMapBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/update-flow-map-block";
import { buildNodeParticleSet, type NodeParticleSet, type NpeBuildContext } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { loadNpeTextureContent } from "../../../packages/babylon-lite/src/particle/node/npe-texture-content";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { NpeTextureContent, NpeTextureValue } from "../../../packages/babylon-lite/src/particle/node/npe-value";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { createSceneContext, disposeScene, getFrameGraph } from "../../../packages/babylon-lite/src/scene/scene-core";

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
        _disposables: [],
    } as unknown as SceneContext;
}

/** Mirror scene disposal: mark it disposed, run its early release and disposers, then fail the test on any later camera read. */
function disposeFlowScene(scene: SceneContext): void {
    scene._z = true;
    scene._earlyDispose?.();
    for (const dispose of scene._disposables.splice(0)) {
        dispose();
    }
    Object.defineProperty(scene, "camera", {
        get: () => {
            throw new Error("flow map read a disposed scene");
        },
    });
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
        input: () => strengthGetter,
        texture: () => source,
        addBuildPromise(promise: Promise<void>) {
            promises.push(promise);
        },
    } as unknown as NpeBuildContext;
    const block = { id: 1, className: "UpdateFlowMapBlock", name: "flow", inputs: [], serialized: {} } as ParsedParticleBlock;
    updateFlowMapBlock.build(block, ctx);
    await Promise.all(promises);
    // animateParticleSystem prepares every frame before it runs the update steps.
    system._prepareFrame?.();
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

    it("hooks frame preparation into the system only once the flow map decodes", async () => {
        const scene = createFlowScene();
        const failed = createParticleSystem(1);
        await attachFlowMap(failed, flowMap([255, 128, 128, 255]), () => 1, scene, { url: "flow.png", invertY: false, _content: Promise.reject(new Error("decode failed")) });
        expect(failed._prepareFrame).toBeUndefined();

        // The decoded map hooks the system itself, so discarding the set discards its frame work.
        const discarded = createParticleSystem(1);
        await attachFlowMap(discarded, flowMap([255, 128, 128, 255]), () => 1, scene);
        expect(discarded._prepareFrame).toBeTypeOf("function");
        expect(scene._beforeRender).toHaveLength(0);
    });

    it("leaves no frame work on the scene when a later block rejects the build", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => new Promise(() => undefined))
        );
        const scene = createFlowScene();
        const graph = parseNodeParticleSource({
            blocks: [
                {
                    customType: "BABYLON.SystemBlock",
                    id: 4,
                    capacity: 1,
                    inputs: [
                        { name: "particle", targetBlockId: 3, targetConnectionName: "output" },
                        { name: "emitRate", targetBlockId: 3, targetConnectionName: "missing" },
                    ],
                },
                {
                    customType: "BABYLON.UpdateFlowMapBlock",
                    id: 3,
                    inputs: [
                        { name: "particle", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "flowMap", targetBlockId: 2, targetConnectionName: "texture" },
                    ],
                },
                { customType: "BABYLON.CreateParticleBlock", id: 1, inputs: [] },
                { customType: "BABYLON.ParticleTextureSourceBlock", id: 2, url: "flow.png", inputs: [] },
            ],
        });

        await expect(buildNodeParticleSet({ _device: {} } as never, scene, graph)).rejects.toThrow("emitRate");
        expect(scene._beforeRender).toHaveLength(0);
    });

    it("re-projects through a moving camera on every simulated frame", async () => {
        const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
        const system = createParticleSystem(1);
        system.emitRate = 0;
        system.buffer.alive = 1;
        system.buffer.lifeTime[0] = 10;
        system.buffer.posX[0] = 1;
        // The left texel pushes +x and the right texel pushes -x.
        await attachFlowMap(system, flowMap([255, 128, 128, 255, 0, 128, 128, 255], 2, 1), () => 1, createFlowScene(camera));
        startParticleSystem(system);

        const start = system.buffer.dirX[0]!;
        animateParticleSystem(system, 1);
        const firstDelta = system.buffer.dirX[0]! - start;
        camera.alpha = -Math.PI / 2;
        const middle = system.buffer.dirX[0]!;
        animateParticleSystem(system, 1);
        const secondDelta = system.buffer.dirX[0]! - middle;

        expect(firstDelta).not.toBe(0);
        expect(Math.sign(secondDelta)).toBe(-Math.sign(firstDelta));
    });

    it("keeps the last projection without reading the scene once it is disposed", async () => {
        const scene = createFlowScene();
        const system = createParticleSystem(1);
        system.emitRate = 0;
        system.buffer.alive = 1;
        system.buffer.lifeTime[0] = 10;
        system.buffer.posX[0] = 1;
        await attachFlowMap(system, flowMap([255, 128, 128, 255, 0, 128, 128, 255], 2, 1), () => 1, scene);
        startParticleSystem(system);

        const start = system.buffer.dirX[0]!;
        animateParticleSystem(system, 1);
        const liveDelta = system.buffer.dirX[0]! - start;
        disposeFlowScene(scene);
        const middle = system.buffer.dirX[0]!;
        animateParticleSystem(system, 1);

        expect(liveDelta).not.toBe(0);
        expect(system.buffer.dirX[0]! - middle).toBeCloseTo(liveDelta, 6);
    });

    it("keeps the last projection when real scene disposal stops at a throwing task teardown", async () => {
        const engine = createNullEngine();
        (engine as { canvas: unknown }).canvas = { width: 100, height: 100 };
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
        scene.camera = camera;
        const teardownFailure = new Error("task teardown failed");
        _appendTask(getFrameGraph(scene), {
            name: "failing-teardown",
            engine,
            _passes: [],
            record() {},
            dispose() {
                throw teardownFailure;
            },
        } as Task);
        const system = createParticleSystem(1);
        system.emitRate = 0;
        system.buffer.alive = 1;
        system.buffer.lifeTime[0] = 10;
        system.buffer.posX[0] = 1;
        // The left texel pushes +x and the right texel pushes -x.
        await attachFlowMap(system, flowMap([255, 128, 128, 255, 0, 128, 128, 255], 2, 1), () => 1, scene);
        startParticleSystem(system);

        const start = system.buffer.dirX[0]!;
        animateParticleSystem(system, 1);
        const liveDelta = system.buffer.dirX[0]! - start;
        expect(() => disposeScene(scene)).toThrow(teardownFailure);
        // Teardown stopped before the camera was cleared, so re-projecting from the scene would reverse the force.
        camera.alpha = -Math.PI / 2;
        const middle = system.buffer.dirX[0]!;
        animateParticleSystem(system, 1);

        expect(liveDelta).not.toBe(0);
        expect(system.buffer.dirX[0]! - middle).toBeCloseTo(liveDelta, 6);
    });

    it("leaves scene disposers in place, chains one early release, and detaches a build still decoding", async () => {
        const scene = createFlowScene();
        // A material rebuild saves the disposer count before it awaits; a first flow-map build inside that window
        // must not move the saved prefix, or the rebuild's dedupe keeps a second copy of a shared cleanup.
        const tail = (): void => undefined;
        scene._disposables.push(tail);
        const earlier = vi.fn();
        scene._earlyDispose = earlier;
        const map = flowMap([255, 128, 128, 255]);
        await attachFlowMap(createParticleSystem(1), map, () => 1, scene);
        const release = scene._earlyDispose;
        let resolveContent!: (content: NpeTextureContent) => void;
        const pending = createParticleSystem(1);
        const attached = attachFlowMap(pending, map, () => 1, scene, { url: "flow.png", invertY: false, _content: new Promise((resolve) => (resolveContent = resolve)) });

        expect(scene._disposables).toHaveLength(1);
        expect(scene._disposables[0]).toBe(tail);
        expect(release).not.toBe(earlier);
        expect(scene._earlyDispose).toBe(release);

        disposeFlowScene(scene);
        resolveContent(map);
        await attached;
        pending._scaledStep = 1;
        pending.updateSteps[0]!(0);

        expect(earlier).toHaveBeenCalledOnce();
        expect(pending.buffer.dirX[0]).toBe(0);
    });

    it("starts detached without registering on a scene disposed before its first flow-map build", async () => {
        const scene = createFlowScene();
        disposeFlowScene(scene);
        const system = createParticleSystem(1);
        system.emitRate = 0;
        system.buffer.alive = 1;
        system.buffer.lifeTime[0] = 10;
        await attachFlowMap(system, flowMap([255, 128, 128, 255]), () => 1, scene);
        startParticleSystem(system);
        animateParticleSystem(system, 1);

        expect(scene._disposables).toHaveLength(0);
        expect(scene._earlyDispose).toBeUndefined();
        expect(system.buffer.dirX[0]).toBe(0);
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
        const set = await buildNodeParticleSet({ _device: {} } as never, scene, graph);
        const system = set.systems[0]!;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(originalFlowInput.targetBlockId).toBe(2);
        expect(graph.blocks.get(3)!.inputs).toContain(originalFlowInput);
        expect(scene._beforeRender).toHaveLength(0);
        camera._vpCache.fill(0);
        scene.surface.canvas.width = 200;
        scene.surface.canvas.height = 100;
        system._prepareFrame!();
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
        const set = await buildNodeParticleSet({ _device: {} } as never, scene, graph);
        const system = set.systems[0]!;
        system.buffer.angle[0] = 7;
        system._prepareFrame!();
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
        let output: NpeTextureValue | undefined;
        const ctx = {
            state: { textureBaseUrl: "https://example.test/textures/" },
            setTexture(_blockId: number, _name: string, value: NpeTextureValue) {
                output = value;
            },
        } as unknown as NpeBuildContext;

        particleTextureSourceBlock.build(block, ctx);

        expect(output).toMatchObject({ url: "data:image/png;base64,AA==", invertY: true });
    });

    it("does not fetch CPU texture content for unsupported URL schemes", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await expect(loadNpeTextureContent({ url: "javascript:alert(1)", invertY: false })).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
