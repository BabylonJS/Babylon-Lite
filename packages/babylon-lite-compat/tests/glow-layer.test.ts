import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Lite from "babylon-lite";
import type { GlowPostProcessTask, GlowPostProcessTaskConfig, Mesh as LiteMesh, RenderTask, SceneContext, RenderTarget, Task } from "babylon-lite";

const hooks = vi.hoisted(() => ({
    create: vi.fn<(options: GlowPostProcessTaskConfig, engine: Lite.EngineContext, scene: SceneContext) => GlowPostProcessTask>(),
    prepare: vi.fn<() => Promise<void>>(),
    build: vi.fn(),
}));

vi.mock("babylon-lite", async (original) => ({
    ...(await original<typeof Lite>()),
    createGlowPostProcessTask: hooks.create,
    buildFrameGraphTask: hooks.build,
}));

import { createPbrMaterial } from "babylon-lite";
import { createFrameGraph } from "../../babylon-lite/src/frame-graph/frame-graph";
import { GlowLayer } from "../src/layers/glow-layer";
import { Color3, Color4 } from "../src/math/color";
import { Mesh } from "../src/meshes/meshes";
import { PBRMaterial, StandardMaterial } from "../src/materials/materials";
import { NodeMaterial } from "../src/materials/node-material";
import { Observable } from "../src/misc/observable";
import { Logger } from "../src/misc/misc-utils";
import { Scene } from "../src/scene/scene";
import { BaseTexture } from "../src/textures/textures";
import type { AbstractEngine } from "../src/engine/engine";
import type { Camera } from "../src/cameras/cameras";

function fixture(headless = false) {
    const late: (() => Promise<void>)[] = [];
    const engine: AbstractEngine = Object.assign({} as AbstractEngine, {
        _headless: headless,
        _lite: {},
        _registerLateWork: (work: () => Promise<void>) => late.push(work),
    });
    const graph = createFrameGraph(engine._lite);
    const target = {} as RenderTarget;
    const resolve = {} as RenderTarget;
    const producer: RenderTask = Object.assign({} as RenderTask, { name: "scene", config: { rt: target, rst: resolve }, _passes: [] });
    graph._tasks.push(producer);
    const native: SceneContext = Object.assign({} as SceneContext, { _frameGraph: graph, defaultRenderTask: producer, meshes: [], camera: null });
    const flushes = new Set<() => void>();
    const scene: Scene = Object.assign(Object.create(Scene.prototype), {
        _lite: native,
        _engine: engine,
        _meshWrappers: new Map(),
        _meshes: [],
        _materials: [],
        _loadedMaterialCache: new Map(),
        _beforeRenderFlushCallbacks: flushes,
        onDisposeObservable: new Observable<Scene>(),
    });
    const mesh = (material: StandardMaterial | PBRMaterial | NodeMaterial = new StandardMaterial("surface", scene), isLed = false): Mesh => {
        const lite = Object.assign({} as LiteMesh, { material: material._lite, _gpu: {} });
        const value = Object.assign(Object.create(Mesh.prototype) as Mesh, {
            _lite: lite,
            _scene: scene,
            _material: material,
            _wrappedLiteMaterial: material._lite,
            _liteOnlyMaterial: false,
            metadata: { isLed },
        });
        scene._registerMesh(value, lite);
        native.meshes.push(lite);
        return value;
    };
    const flush = (): void => {
        for (const callback of flushes) {
            callback();
        }
    };
    return { scene, native, engine, graph, producer, target, resolve, late, mesh, flushes, flush };
}

function task(): GlowPostProcessTask {
    return hooks.create.mock.results.at(-1)!.value;
}

function fakeTexture(level = 1): BaseTexture {
    return Object.assign(Object.create(BaseTexture.prototype) as BaseTexture, { _level: level, _lite: {} as Lite.Texture2D });
}

describe("GlowLayer adapter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hooks.prepare.mockResolvedValue(undefined);
        hooks.create.mockImplementation((config) =>
            Object.assign({} as GlowPostProcessTask, config, {
                name: config.name ?? "glow",
                outputTexture: config.targetTexture,
                includedOnlyMeshes: new Set(),
                excludedMeshes: new Set(),
                _passes: [],
                _preload: hooks.prepare,
                record: vi.fn(),
                dispose: vi.fn(),
            })
        );
    });

    it("defers setup until late work, uses the declared producer outputs and forwards current state", async () => {
        const f = fixture();
        const glow = new GlowLayer("ledGlow", f.scene, { blurKernelSize: 32, mainTextureRatio: 0.75 });
        glow.intensity = 0.6;
        glow.blurKernelSize = 48;
        glow.neutralColor = new Color4(0.1, 0, 0, 1);
        expect(hooks.create).not.toHaveBeenCalled();
        expect(glow.isReady()).toBe(false);
        await f.late[0]!();
        expect(hooks.create).toHaveBeenCalledWith(
            expect.objectContaining({ name: "ledGlow", targetTexture: f.target, resolveTexture: f.resolve, blurKernelSize: 48, mainTextureRatio: 0.75, intensity: 0.6 }),
            f.engine._lite,
            f.native
        );
        expect(f.graph._tasks).toEqual([f.producer, task()]);
        expect(hooks.build).toHaveBeenCalledWith(f.graph, task());
        expect(glow.getClassName()).toBe("GlowLayer");
        expect(glow.getScene()).toBe(f.scene);
        expect(glow.isReady()).toBe(true);
        glow.intensity = 0.8;
        glow.blurKernelSize = 64;
        glow.neutralColor.a = 0.5;
        expect(task()).toMatchObject({ intensity: 0.8, blurKernelSize: 64, neutralColor: glow.neutralColor });
        glow.dispose();
    });

    it("runs the NuminaPRO selector with canonical wrappers and a reusable Color4, without scanning scene.meshes", async () => {
        const f = fixture();
        const material = new StandardMaterial("led", f.scene);
        material.emissiveColor = new Color3(0.2, 0.7, 1);
        const emitter = f.mesh(material, true);
        const occluder = f.mesh();
        const scan = vi.spyOn(f.scene, "meshes", "get").mockImplementation(() => {
            throw new Error("scene mesh scan");
        });
        const results: Color4[] = [];
        const identities: unknown[] = [];
        const glow = new GlowLayer("ledGlow", f.scene);
        glow.customEmissiveTextureSelector = () => null;
        glow.customEmissiveColorSelector = (mesh, subMesh, source, result) => {
            identities.push(mesh, subMesh, source);
            results.push(result);
            if ((mesh.metadata as { isLed: boolean }).isLed) {
                const color = (source as StandardMaterial).emissiveColor;
                result.set(color.r, color.g, color.b, 1);
            } else result.set(0, 0, 0, 1);
        };
        await f.late[0]!();
        const first = { r: 0, g: 0, b: 0, a: 1 };
        const second = { r: 1, g: 1, b: 1, a: 1 };
        task().customEmissiveColorSelector!(emitter._lite, material._lite, first);
        expect(task().customEmissiveTextureSelector!(emitter._lite, material._lite)).toBeNull();
        task().customEmissiveColorSelector!(occluder._lite, occluder._lite.material!, second);
        expect(first).toEqual({ r: 0.2, g: 0.7, b: 1, a: 1 });
        expect(second).toEqual({ r: 0, g: 0, b: 0, a: 1 });
        expect(identities.slice(0, 3)).toEqual([emitter, null, material]);
        expect(results[0]).toBe(results[1]);
        expect(scan).not.toHaveBeenCalled();
        glow.dispose();
    });

    it("preserves texture/color callback order and does not apply custom texture levels", async () => {
        const f = fixture();
        const mesh = f.mesh();
        const texture = fakeTexture(4);
        const order: string[] = [];
        const glow = new GlowLayer("glow", f.scene);
        glow.customEmissiveTextureSelector = () => {
            order.push("texture");
            return texture;
        };
        glow.customEmissiveColorSelector = (_mesh, _subMesh, _material, result) => {
            order.push("color");
            result.set(0.4, 0.5, 0.6, 1);
        };
        await f.late[0]!();
        const result = { r: 0, g: 0, b: 0, a: 1 };
        task().customEmissiveColorSelector!(mesh._lite, mesh._lite.material!, result);
        expect(task().customEmissiveTextureSelector!(mesh._lite, mesh._lite.material!)).toBe(texture._lite);
        expect(order).toEqual(["texture", "color"]);
        expect(result).toEqual({ r: 0.4, g: 0.5, b: 0.6, a: 1 });
        glow.customEmissiveTextureSelector = null;
        expect(task().customEmissiveTextureSelector).toBeUndefined();
        glow.dispose();
    });

    it("maps included-only precedence, exclusions and exclude-by-default to native sets", async () => {
        const f = fixture();
        const a = f.mesh();
        const b = f.mesh();
        const glow = new GlowLayer("glow", f.scene, { excludeByDefault: true });
        glow.addExcludedMesh(a);
        glow.addIncludedOnlyMesh(a);
        glow.addIncludedOnlyMesh(a);
        expect(glow.hasMesh(a)).toBe(true);
        expect(glow.hasMesh(b)).toBe(false);
        await f.late[0]!();
        expect(task().includedOnlyMeshes).toEqual(new Set([a._lite]));
        expect(task().excludedMeshes.size).toBe(0);
        glow.removeIncludedOnlyMesh(a);
        expect(task().excludedMeshes).toEqual(new Set([a._lite]));
        glow.setExcludedByDefault(false);
        expect(glow.hasMesh(a)).toBe(false);
        expect(glow.hasMesh(b)).toBe(true);
        glow.removeExcludedMesh(a);
        expect(glow.hasMesh(a)).toBe(true);
        glow.dispose();
    });

    it("gates the native task by enabled state and selected camera without a frame observer", async () => {
        const f = fixture();
        const camera = { _lite: {} } as Camera;
        const other = { _lite: {} } as Camera;
        f.native.camera = camera._lite;
        const glow = new GlowLayer("glow", f.scene, { camera });
        await f.late[0]!();
        expect(task().isEnabled).toBe(true);
        f.native.camera = other._lite;
        expect(task().isEnabled).toBe(false);
        glow.camera = other;
        expect(task().isEnabled).toBe(true);
        expect(task().camera).toBe(other._lite);
        glow.isEnabled = false;
        expect(task().isEnabled).toBe(false);
        expect(glow.isEnabled).toBe(false);
        glow.dispose();
    });

    it("removes its task before disposal and cleans up on scene disposal", async () => {
        const f = fixture();
        const glow = new GlowLayer("glow", f.scene);
        await f.late[0]!();
        const native = task();
        f.scene.onDisposeObservable.notifyObservers(f.scene);
        expect(f.graph._tasks).toEqual([f.producer]);
        expect(native.dispose).toHaveBeenCalledOnce();
        expect(glow.isReady()).toBe(false);
        glow.dispose();
        expect(native.dispose).toHaveBeenCalledOnce();
        expect(f.scene.onDisposeObservable.hasObservers()).toBe(false);
    });

    it("does not attach a task disposed while deformation preparation is pending", async () => {
        const f = fixture();
        let resume!: () => void;
        hooks.prepare.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resume = resolve;
                })
        );
        const glow = new GlowLayer("glow", f.scene);
        const initializing = f.late[0]!();
        await Promise.resolve();
        glow.dispose();
        resume();
        await initializing;
        expect(f.graph._tasks).toEqual([f.producer]);
        expect(task().dispose).toHaveBeenCalledOnce();
        expect(hooks.build).not.toHaveBeenCalled();
    });

    it("applies property and membership changes made while preparation is pending", async () => {
        const f = fixture();
        const mesh = f.mesh();
        let resume!: () => void;
        hooks.prepare.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resume = resolve;
                })
        );
        const glow = new GlowLayer("glow", f.scene);
        const initializing = f.late[0]!();
        await Promise.resolve();
        glow.intensity = 0.3;
        glow.blurKernelSize = 48;
        glow.isEnabled = false;
        glow.neutralColor = new Color4(0, 0.1, 0, 1);
        glow.addIncludedOnlyMesh(mesh);
        glow.customEmissiveTextureSelector = () => null;
        resume();
        await initializing;
        expect(task()).toMatchObject({ intensity: 0.3, blurKernelSize: 48, isEnabled: false, neutralColor: glow.neutralColor });
        expect(task().includedOnlyMeshes).toEqual(new Set([mesh._lite]));
        expect(task().customEmissiveTextureSelector).toBeTypeOf("function");
        glow.dispose();
    });

    it("starts from the producer's current destination when it changes during preparation", async () => {
        const f = fixture();
        let resume!: () => void;
        hooks.prepare.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resume = resolve;
                })
        );
        const glow = new GlowLayer("glow", f.scene);
        const initializing = f.late[0]!();
        await Promise.resolve();
        const retargeted = {} as RenderTarget;
        f.producer.config.rt = retargeted;
        resume();
        await initializing;
        expect(task()).toMatchObject({ outputTexture: retargeted, resolveTexture: f.resolve });
        expect(f.graph._tasks).toEqual([f.producer, task()]);
        glow.dispose();
    });

    it("follows its producer through a scene-output attach and detach, staying ahead of the inserted chain", async () => {
        const f = fixture();
        const glow = new GlowLayer("glow", f.scene);
        await f.late[0]!();
        const glowTask = task();
        hooks.build.mockClear();
        f.flush();
        expect(hooks.build).not.toHaveBeenCalled();
        // As SSAO does: its chain is inserted right after the producer, whose resolve now feeds that chain.
        const ssao = { name: "ssao", _passes: [] } as unknown as Task;
        const source = {} as RenderTarget;
        f.graph._tasks.splice(1, 0, ssao);
        f.producer.config.rst = source;
        f.flush();
        expect(glowTask).toMatchObject({ outputTexture: f.target, resolveTexture: source });
        expect(f.graph._tasks).toEqual([f.producer, glowTask, ssao]);
        expect(hooks.build).toHaveBeenCalledOnce();
        expect(hooks.build).toHaveBeenCalledWith(f.graph, glowTask);
        f.flush();
        expect(hooks.build).toHaveBeenCalledOnce();
        f.graph._tasks.splice(f.graph._tasks.indexOf(ssao), 1);
        f.producer.config.rst = f.resolve;
        f.flush();
        expect(glowTask.resolveTexture).toBe(f.resolve);
        expect(f.graph._tasks).toEqual([f.producer, glowTask]);
        expect(hooks.build).toHaveBeenCalledTimes(2);
        glow.dispose();
        expect(f.flushes.size).toBe(0);
    });

    it("forwards explicitly supplied custom-chain targets and anchor", async () => {
        const f = fixture();
        const target = {} as RenderTarget;
        const glow = new GlowLayer("glow", f.scene, { targetTexture: target, afterTask: f.producer });
        Object.defineProperty(f.native, "defaultRenderTask", { value: undefined });
        await f.late[0]!();
        expect(task().outputTexture).toBe(target);
        expect(task().resolveTexture).toBeUndefined();
        // Its owner rewires an explicit placement.
        expect(f.flushes.size).toBe(0);
        glow.dispose();
    });

    it("surfaces unsupported options and pending selected textures explicitly", async () => {
        const f = fixture();
        expect(() => new GlowLayer("glow", f.scene, { renderingGroupId: 1 })).toThrow("Order rendering tasks");
        expect(() => new GlowLayer("glow", f.scene, { mainTextureSamples: 4 })).toThrow("single-sample");
        expect(() => new GlowLayer("glow", f.scene, { generateStencilBuffer: true })).toThrow("without stencil");
        const mesh = f.mesh();
        const glow = new GlowLayer("glow", f.scene);
        glow.customEmissiveTextureSelector = () => ({}) as BaseTexture;
        await f.late[0]!();
        expect(() => task().customEmissiveColorSelector!(mesh._lite, mesh._lite.material!, { r: 0, g: 0, b: 0, a: 1 })).toThrow("ready 2D texture");
        Reflect.set(glow, "customEmissiveTextureSelector", () => undefined);
        expect(() => task().customEmissiveColorSelector!(mesh._lite, mesh._lite.material!, { r: 0, g: 0, b: 0, a: 1 })).toThrow("ready 2D texture");
        glow.dispose();
    });

    it("exposes the native effective white emissive factor of loaded PBR textures to callbacks", async () => {
        const f = fixture();
        const native = createPbrMaterial({ emissiveTexture: {} as Lite.Texture2D });
        const material = PBRMaterial._fromLite("loaded", native, f.scene);
        const mesh = f.mesh(material);
        const glow = new GlowLayer("glow", f.scene);
        glow.customEmissiveTextureSelector = () => null;
        glow.customEmissiveColorSelector = (_mesh, _subMesh, source, result) => {
            const color = (source as PBRMaterial).emissiveColor;
            result.set(color.r, color.g, color.b, 1);
        };
        await f.late[0]!();
        const result = { r: 0, g: 0, b: 0, a: 1 };
        task().customEmissiveColorSelector!(mesh._lite, native, result);
        expect(result).toEqual({ r: 1, g: 1, b: 1, a: 1 });
        expect(native._emissiveColor).toBeUndefined();
        glow.dispose();
    });

    it("passes NodeMaterial wrappers to selectors", async () => {
        const f = fixture();
        const material = new NodeMaterial("node", f.scene);
        material._lite = {} as NonNullable<NodeMaterial["_lite"]>;
        const mesh = f.mesh(material);
        const seen: unknown[] = [];
        const glow = new GlowLayer("glow", f.scene);
        glow.customEmissiveColorSelector = (_mesh, _subMesh, source, result) => {
            seen.push(source);
            result.set(1, 0, 0, 1);
        };
        await f.late[0]!();
        const result = { r: 0, g: 0, b: 0, a: 1 };
        task().customEmissiveColorSelector!(mesh._lite, material._lite, result);
        expect(seen).toEqual([material]);
        expect(result).toEqual({ r: 1, g: 0, b: 0, a: 1 });
        glow.dispose();
    });

    it("reports an inert facade for a headless engine", () => {
        const error = vi.spyOn(Logger, "Error").mockImplementation(() => undefined);
        const f = fixture(true);
        const glow = new GlowLayer("glow", f.scene);
        expect(glow.isSupported).toBe(false);
        expect(glow.isReady()).toBe(false);
        expect(f.late).toHaveLength(0);
        expect(error).toHaveBeenCalledOnce();
        glow.dispose();
        error.mockRestore();
    });
});
