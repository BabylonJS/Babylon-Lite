import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { enableMaterialPlugins } from "../../../packages/babylon-lite/src/material/plugin/enable-material-plugins";
import type { MaterialPlugin } from "../../../packages/babylon-lite/src/material/plugin/material-plugin";
import { bakeStdPluginMaterial, refreshStdPluginUbos, registerStdPlugins } from "../../../packages/babylon-lite/src/material/plugin/std-plugin-bridge";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { _computeStandardMaterialFeatures, type StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material";
import { MATERIAL_ALPHA_BLEND } from "../../../packages/babylon-lite/src/material/standard/standard-flags";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { StdExt } from "../../../packages/babylon-lite/src/material/standard/standard-flags";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { addToScene, createSceneContext, disposeScene, onBeforeRender, type RuntimeSceneBuildHooks, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap";
import { rebuildSceneRenderables } from "../../../packages/babylon-lite/src/scene/scene-rebuild";

interface MockBuffer {
    readonly id: number;
    readonly destroy: ReturnType<typeof vi.fn>;
}

function makeEngine(onWrite?: () => void): {
    engine: EngineContext;
    createBuffer: ReturnType<typeof vi.fn>;
    writeBuffer: ReturnType<typeof vi.fn>;
    uploadedValues: number[];
    buffers: MockBuffer[];
} {
    const uploadedValues: number[] = [];
    const buffers: MockBuffer[] = [];
    const writeBuffer = vi.fn((_target: GPUBuffer, _targetOffset: number, source: ArrayBuffer, sourceOffset: number) => {
        onWrite?.();
        uploadedValues.push(new Float32Array(source, sourceOffset, 1)[0]!);
    });
    let bufferId = 0;
    const createBuffer = vi.fn(() => {
        const buffer = { id: ++bufferId, destroy: vi.fn() };
        buffers.push(buffer);
        return buffer as unknown as GPUBuffer;
    });
    const device = {
        createBuffer,
        queue: { writeBuffer },
    } as unknown as GPUDevice;
    const engine = { _device: device, _renderingContexts: [] } as unknown as EngineContext;
    Object.assign(engine, { engine, surfaces: [engine], _surfaces: [engine] });
    return { engine, createBuffer, writeBuffer, uploadedValues, buffers };
}

function valuePlugin(value: { current: number }, dynamic = true): MaterialPlugin {
    return {
        name: "value-plugin",
        dynamic,
        getUniforms: () => ({ ubo: [{ name: "pluginValue", type: "f32" }] }),
        writeUbo(data, offsets) {
            data[offsets.get("pluginValue")! / 4] = value.current;
        },
    };
}

function mesh(material: StandardMaterialProps): Mesh {
    return {
        material,
        _gpu: {
            positionBuffer: { destroy: vi.fn() },
            normalBuffer: { destroy: vi.fn() },
            uvBuffer: { destroy: vi.fn() },
            indexBuffer: { destroy: vi.fn() },
        },
    } as unknown as Mesh;
}

function pluginScene(engine: EngineContext, materials: StandardMaterialProps[]): SceneContext {
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    for (const material of materials) {
        addToScene(scene, mesh(material));
    }
    return scene;
}

describe("dynamic Standard material plugins", () => {
    let registered: StdExt;

    beforeEach(() => {
        registered = undefined as unknown as StdExt;
    });

    it.each(["signature", "writer", "allocation", "upload"] as const)("keeps the last committed generation after a %s failure and retries cleanly", (failure) => {
        const { engine, createBuffer, writeBuffer, uploadedValues, buffers } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const scene = pluginScene(engine, [material]);
        registerStdPlugins(scene, (ext) => {
            registered = ext;
        });
        const previousIndex = material._pi;
        const previousPlugins = material._preparedPlugins;
        const previousFeatures = material._renderFeatures;
        const previousBuffer = buffers[0]!;
        const mesh = scene.meshes[0]!;
        const previousDisposers: (() => void)[] = [];
        scene._meshDisposables.set(mesh, previousDisposers);
        scene._built = true;
        let failing = true;
        const proposed: MaterialPlugin[] = [
            {
                name: `replacement-${failure}`,
                dynamic: true,
                getUniforms() {
                    if (failing && failure === "signature") {
                        throw new Error("signature failed");
                    }
                    return { ubo: [{ name: "replacementValue", type: "vec4<f32>" }] };
                },
                writeUbo(data, offsets) {
                    if (failing && failure === "writer") {
                        throw new Error("writer failed");
                    }
                    data[offsets.get("replacementValue")! / 4] = 17;
                },
            },
        ];
        material.plugins = proposed;
        if (failure === "allocation") {
            createBuffer.mockImplementationOnce(() => {
                throw new Error("allocation failed");
            });
        }
        if (failure === "upload") {
            writeBuffer.mockImplementationOnce(() => {
                throw new Error("upload failed");
            });
        }

        expect(() => bakeStdPluginMaterial(material, scene)).toThrow(`${failure} failed`);
        expect(material.plugins).toBe(proposed);
        expect(material._pi).toBe(previousIndex);
        expect(material._preparedPlugins).toBe(previousPlugins);
        expect(material._renderFeatures).toBe(previousFeatures);
        expect(scene._meshDisposables.get(mesh)).toBe(previousDisposers);
        expect(previousDisposers).toHaveLength(0);
        expect(scene._materialSwapQueue).toHaveLength(0);
        expect(engine._retirements).toBeUndefined();
        expect(previousBuffer.destroy).not.toHaveBeenCalled();
        if (failure === "upload") {
            expect(buffers[1]!.destroy).toHaveBeenCalledOnce();
        }
        const oldEntries: GPUBindGroupEntry[] = [];
        registered._bind!(material, oldEntries, 0, mesh, scene);
        expect((oldEntries[0]!.resource as GPUBufferBinding).buffer).toBe(previousBuffer);
        uploadedValues.length = 0;
        refreshStdPluginUbos(scene);
        expect(uploadedValues).toEqual([1]);

        failing = false;
        bakeStdPluginMaterial(material, scene);
        expect(material._pi).not.toBe(previousIndex);
        expect(material._preparedPlugins).toEqual(proposed);
        expect(material._renderFeatures).not.toBe(previousFeatures);
        const newEntries: GPUBindGroupEntry[] = [];
        registered._bind!(material, newEntries, 0, mesh, scene);
        expect((newEntries[0]!.resource as GPUBufferBinding).buffer).toBe(buffers.at(-1));
        expect(scene._materialSwapQueue).toEqual([mesh]);
        uploadedValues.length = 0;
        refreshStdPluginUbos(scene);
        expect(uploadedValues).toEqual([17]);
    });

    it("keeps same-signature material values isolated and refreshes dynamic UBOs", () => {
        const { engine, writeBuffer, uploadedValues } = makeEngine();
        const valueA = { current: 1 };
        const valueB = { current: 2 };
        const materialA = createStandardMaterial();
        const materialB = createStandardMaterial();
        materialA.plugins = [valuePlugin(valueA)];
        materialB.plugins = [valuePlugin(valueB)];
        const scene = pluginScene(engine, [materialA, materialB]);

        registerStdPlugins(scene, (ext) => {
            registered = ext;
        });

        const entriesA: GPUBindGroupEntry[] = [];
        const entriesB: GPUBindGroupEntry[] = [];
        registered._bind!(materialA, entriesA, 0, undefined, scene);
        registered._bind!(materialB, entriesB, 0, undefined, scene);
        expect((entriesA[0]!.resource as GPUBufferBinding).buffer).not.toBe((entriesB[0]!.resource as GPUBufferBinding).buffer);
        expect(uploadedValues).toEqual([1, 2]);

        valueA.current = 3;
        valueB.current = 4;
        writeBuffer.mockClear();
        uploadedValues.length = 0;
        refreshStdPluginUbos(scene);

        expect(uploadedValues).toEqual([3, 4]);
    });

    it("reuses the prepared plugin order during dynamic UBO refresh", () => {
        const { engine } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [
            {
                name: "later",
                priority: 600,
                dynamic: true,
                getUniforms: () => ({ ubo: [{ name: "laterValue", type: "f32" }] }),
                writeUbo: (data, offsets) => (data[offsets.get("laterValue")! / 4] = 1),
            },
            {
                name: "earlier",
                priority: 100,
                dynamic: true,
                getUniforms: () => ({ ubo: [{ name: "earlierValue", type: "f32" }] }),
                writeUbo: (data, offsets) => (data[offsets.get("earlierValue")! / 4] = 2),
            },
        ];
        const scene = pluginScene(engine, [material]);
        registerStdPlugins(scene, (ext) => {
            registered = ext;
        });
        expect(material._preparedPlugins?.map((plugin) => plugin.name)).toEqual(["earlier", "later"]);
        const filter = vi.spyOn(Array.prototype, "filter");
        const sort = vi.spyOn(Array.prototype, "sort");

        refreshStdPluginUbos(scene);

        expect(filter).not.toHaveBeenCalled();
        expect(sort).not.toHaveBeenCalled();
        filter.mockRestore();
        sort.mockRestore();
    });

    it("bakes a Standard material created after initial registration", () => {
        const { engine } = makeEngine();
        const scene = pluginScene(engine, []);
        registerStdPlugins(scene, (ext) => {
            registered = ext;
        });
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 5 }, false)];

        bakeStdPluginMaterial(material, scene);
        const entries: GPUBindGroupEntry[] = [];
        const disposers: (() => void)[] = [];
        registered._bind!(material, entries, 0, undefined, scene, disposers, true);

        expect(entries).toHaveLength(1);
        expect(material._pi).toBeGreaterThan(0);
        disposers.forEach((dispose) => dispose());
    });

    it("bakes a material shared by multiple meshes only once", () => {
        const { engine, createBuffer } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const scene = pluginScene(engine, [material, material]);

        registerStdPlugins(scene, (ext) => {
            registered = ext;
        });

        expect(createBuffer).toHaveBeenCalledTimes(1);
    });

    it("refreshes after public before-render value updates regardless of enable order", () => {
        const order: string[] = [];
        const { engine, uploadedValues } = makeEngine(() => order.push("refresh"));
        const value = { current: 1 };
        const material = createStandardMaterial();
        material.plugins = [valuePlugin(value)];
        const scene = pluginScene(engine, [material]);
        scene._beforeRender.push(() => {
            order.push("existing");
            value.current = 2;
        });

        enableMaterialPlugins(scene);
        uploadedValues.length = 0;
        order.length = 0;
        onBeforeRender(scene, () => {
            order.push("future");
            value.current = 3;
        });

        for (const callback of scene._beforeRender) {
            callback(0);
        }

        expect(order).toEqual(["future", "existing", "refresh"]);
        expect(uploadedValues).toEqual([2]);
    });

    it("keeps dynamic refresh state scoped to each scene", () => {
        const { engine, uploadedValues } = makeEngine();
        const valueA = { current: 1 };
        const valueB = { current: 2 };
        const materialA = createStandardMaterial();
        const materialB = createStandardMaterial();
        materialA.plugins = [valuePlugin(valueA)];
        materialB.plugins = [valuePlugin(valueB)];
        const sceneA = pluginScene(engine, [materialA]);
        const sceneB = pluginScene(engine, [materialB]);

        enableMaterialPlugins(sceneA);
        enableMaterialPlugins(sceneB);
        uploadedValues.length = 0;
        valueA.current = 3;
        valueB.current = 4;

        sceneA._beforeRender.forEach((callback) => callback(0));
        expect(uploadedValues).toEqual([3]);

        uploadedValues.length = 0;
        sceneB._beforeRender.forEach((callback) => callback(0));
        expect(uploadedValues).toEqual([4]);
    });

    it("stops uploading and releases the UBO after the final scene mesh is removed", () => {
        const { engine, buffers, writeBuffer } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const scene = pluginScene(engine, [material, material]);
        enableMaterialPlugins(scene);
        const [first, second] = scene.meshes;
        removeFromScene(scene, first!);
        writeBuffer.mockClear();
        refreshStdPluginUbos(scene);
        expect(writeBuffer).toHaveBeenCalledOnce();
        expect(buffers[0]!.destroy).not.toHaveBeenCalled();
        removeFromScene(scene, second!);
        writeBuffer.mockClear();
        refreshStdPluginUbos(scene);
        expect(writeBuffer).not.toHaveBeenCalled();
        expect(buffers[0]!.destroy).toHaveBeenCalledOnce();
        removeFromScene(scene, second!);
        expect(buffers[0]!.destroy).toHaveBeenCalledOnce();
        addToScene(scene, mesh(material));
        expect(buffers).toHaveLength(2);
        refreshStdPluginUbos(scene);
        expect(buffers[1]!.destroy).not.toHaveBeenCalled();
    });

    it("stops main-material uploads on a swap while pending binding owners retain the old UBO", () => {
        const { engine, buffers, writeBuffer } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const scene = pluginScene(engine, [material]);
        registerStdPlugins(scene, (ext) => {
            registered = ext;
        });
        const target = scene.meshes[0]!;
        const pending: (() => void)[] = [];
        registered._bind!(material, [], 0, target, scene, pending);
        scene._built = true;
        scene._runtimeBuilds = { w: true, pendingDisposers: () => pending } as unknown as RuntimeSceneBuildHooks;
        target.material = createStandardMaterial();
        writeBuffer.mockClear();
        refreshStdPluginUbos(scene);
        expect(writeBuffer).not.toHaveBeenCalled();
        processMaterialSwaps(scene);
        disposeGpuResourceRetirements(engine);
        expect(buffers[0]!.destroy).not.toHaveBeenCalled();
        pending.forEach((dispose) => dispose());
        disposeGpuResourceRetirements(engine);
        expect(buffers[0]!.destroy).toHaveBeenCalledOnce();
    });

    it("keeps auxiliary owners alive across main-material swaps and deduplicates their repeated binds", () => {
        const { engine, buffers, writeBuffer } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const scene = pluginScene(engine, [material]);
        registerStdPlugins(scene, (ext) => {
            registered = ext;
        });
        const target = scene.meshes[0]!;
        const auxiliary: (() => void)[] = [];
        registered._bind!(material, [], 0, target, scene, auxiliary, true);
        registered._bind!(material, [], 0, target, scene, auxiliary, true);
        expect(auxiliary).toHaveLength(1);
        target.material = createStandardMaterial();
        writeBuffer.mockClear();
        refreshStdPluginUbos(scene);
        expect(writeBuffer).toHaveBeenCalledOnce();
        expect(buffers[0]!.destroy).not.toHaveBeenCalled();
        auxiliary[0]!();
        auxiliary[0]!();
        writeBuffer.mockClear();
        refreshStdPluginUbos(scene);
        expect(writeBuffer).not.toHaveBeenCalled();
        expect(buffers[0]!.destroy).toHaveBeenCalledOnce();
    });

    it("does not allocate an unowned replacement when an override-only material is re-baked", () => {
        const { engine, buffers, writeBuffer } = makeEngine();
        const scene = pluginScene(engine, []);
        registerStdPlugins(scene, (ext) => {
            registered = ext;
        });
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        bakeStdPluginMaterial(material, scene);
        const originalOwner: (() => void)[] = [];
        registered._bind!(material, [], 0, undefined, scene, originalOwner, true);
        expect(buffers).toHaveLength(1);
        bakeStdPluginMaterial(material, scene);
        expect(buffers).toHaveLength(1);
        expect(buffers[0]!.destroy).not.toHaveBeenCalled();
        writeBuffer.mockClear();
        refreshStdPluginUbos(scene);
        expect(writeBuffer).not.toHaveBeenCalled();
        originalOwner.forEach((dispose) => dispose());
        expect(buffers[0]!.destroy).toHaveBeenCalledOnce();
        const replacementOwner: (() => void)[] = [];
        registered._bind!(material, [], 0, undefined, scene, replacementOwner, true);
        expect(buffers).toHaveLength(2);
        replacementOwner.forEach((dispose) => dispose());
        expect(buffers[1]!.destroy).toHaveBeenCalledOnce();
    });

    it("isolates membership changes for a mesh and material shared between scenes", () => {
        const { engine, buffers, writeBuffer } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const a = pluginScene(engine, [material]);
        const b = pluginScene(engine, []);
        const shared = a.meshes[0]!;
        addToScene(b, shared);
        enableMaterialPlugins(a);
        enableMaterialPlugins(b);
        removeFromScene(a, shared);
        writeBuffer.mockClear();
        refreshStdPluginUbos(a);
        expect(writeBuffer).not.toHaveBeenCalled();
        refreshStdPluginUbos(b);
        expect(writeBuffer).toHaveBeenCalledOnce();
        expect(buffers[0]!.destroy).toHaveBeenCalledOnce();
        expect(buffers[1]!.destroy).not.toHaveBeenCalled();
        shared.material = createStandardMaterial();
        expect(buffers[1]!.destroy).toHaveBeenCalledOnce();
    });

    it("prepares unattached materials without retaining GPU buffers or per-frame uploads", () => {
        const { engine, createBuffer, writeBuffer } = makeEngine();
        const scene = pluginScene(engine, []);
        enableMaterialPlugins(scene);
        for (let index = 0; index < 32; index++) {
            const material = createStandardMaterial();
            material.plugins = [valuePlugin({ current: index })];
            bakeStdPluginMaterial(material, scene);
            expect(material._pi).toBeGreaterThan(0);
        }
        refreshStdPluginUbos(scene);
        expect(createBuffer).not.toHaveBeenCalled();
        expect(writeBuffer).not.toHaveBeenCalled();
        const prepared = createStandardMaterial();
        prepared.plugins = [valuePlugin({ current: 1 })];
        bakeStdPluginMaterial(prepared, scene);
        prepared.plugins = [];
        bakeStdPluginMaterial(prepared, scene);
        expect(prepared._renderFeatures).toBeUndefined();
    });

    it("does not accumulate dynamic uploads after repeated material churn or scan meshes during refresh", () => {
        const { engine, buffers, writeBuffer } = makeEngine();
        const scene = pluginScene(engine, []);
        enableMaterialPlugins(scene);
        for (let index = 0; index < 32; index++) {
            const material = createStandardMaterial();
            material.plugins = [valuePlugin({ current: index })];
            const target = mesh(material);
            addToScene(scene, target);
            removeFromScene(scene, target);
        }
        const iterateMeshes = vi.spyOn(scene.meshes, Symbol.iterator);
        writeBuffer.mockClear();
        refreshStdPluginUbos(scene);
        expect(iterateMeshes).not.toHaveBeenCalled();
        expect(writeBuffer).not.toHaveBeenCalled();
        expect(buffers).toHaveLength(32);
        for (const buffer of buffers) {
            expect(buffer.destroy).toHaveBeenCalledOnce();
        }
        iterateMeshes.mockRestore();
        disposeGpuResourceRetirements(engine);
    });

    it("binds a shared material to each scene's own UBO and isolates disposal", () => {
        const { engine, buffers } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const sceneA = pluginScene(engine, [material]);
        const sceneB = pluginScene(engine, [material]);

        registerStdPlugins(sceneA, (ext) => {
            registered = ext;
        });
        registerStdPlugins(sceneB, (ext) => {
            registered = ext;
        });

        const entriesA: GPUBindGroupEntry[] = [];
        const entriesB: GPUBindGroupEntry[] = [];
        registered._bind!(material, entriesA, 0, undefined, sceneA);
        registered._bind!(material, entriesB, 0, undefined, sceneB);
        expect((entriesA[0]!.resource as GPUBufferBinding).buffer).toBe(buffers[0]);
        expect((entriesB[0]!.resource as GPUBufferBinding).buffer).toBe(buffers[1]);

        sceneA.meshes.length = 0;
        disposeScene(sceneA);
        expect(buffers[0]!.destroy).toHaveBeenCalledOnce();
        expect(buffers[1]!.destroy).not.toHaveBeenCalled();

        const survivingEntries: GPUBindGroupEntry[] = [];
        registered._bind!(material, survivingEntries, 0, undefined, sceneB);
        expect((survivingEntries[0]!.resource as GPUBufferBinding).buffer).toBe(buffers[1]);
    });

    it("does not freeze plugin-free feature detection and only clears an existing plugin state", () => {
        const { engine } = makeEngine();
        const material = createStandardMaterial();
        const scene = pluginScene(engine, [material]);

        enableMaterialPlugins(scene);
        expect(material._renderFeatures).toBeUndefined();

        material.alpha = 0.5;
        expect(_computeStandardMaterialFeatures(material) & MATERIAL_ALPHA_BLEND).toBe(MATERIAL_ALPHA_BLEND);

        material.plugins = [valuePlugin({ current: 1 })];
        bakeStdPluginMaterial(material, scene);
        expect(material._renderFeatures).toBeDefined();

        material.plugins = [];
        bakeStdPluginMaterial(material, scene);
        expect(material._renderFeatures).toBeUndefined();
    });

    it("destroys plugin UBOs when their scene is disposed", () => {
        const { engine, buffers } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const scene = pluginScene(engine, [material]);

        enableMaterialPlugins(scene);
        const buffer = buffers[0]!;
        scene.meshes.length = 0;
        disposeScene(scene);

        expect(buffer.destroy).toHaveBeenCalledOnce();
    });

    it("keeps the old UBO alive while the swap queue is blocked, then retires it after rebinding", () => {
        const { engine, buffers } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const scene = pluginScene(engine, [material]);
        const targetMesh = scene.meshes[0]!;

        registerStdPlugins(scene, (ext) => {
            registered = ext;
        });
        const oldBuffer = buffers[0]!;
        const oldRenderable = { mesh: targetMesh, order: 0, isTransparent: false } as Renderable;
        let reboundBuffer: GPUBuffer | undefined;
        const rebuild = vi.fn((targetScene: SceneContext) => {
            const entries: GPUBindGroupEntry[] = [];
            registered._bind!(material, entries, 0, targetMesh, targetScene);
            reboundBuffer = (entries[0]!.resource as GPUBufferBinding).buffer;
            return { mesh: targetMesh, order: 0, isTransparent: false } as Renderable;
        });
        scene._groups.set(material._buildGroup, Object.assign([targetMesh], { r: rebuild }));
        scene._renderables.push(oldRenderable);
        scene._meshDisposables.set(targetMesh, []);
        scene._built = true;
        let blocked = true;
        scene._runtimeBuilds = {
            get w() {
                return blocked;
            },
            pendingDisposers: () => undefined,
        } as unknown as RuntimeSceneBuildHooks;
        bakeStdPluginMaterial(material, scene);

        expect(buffers).toHaveLength(2);
        expect(scene._materialSwapQueue).toEqual([targetMesh]);
        expect(oldBuffer.destroy).not.toHaveBeenCalled();
        expect(engine._retirements).toBeUndefined();

        processMaterialSwaps(scene);
        expect(rebuild).not.toHaveBeenCalled();
        expect(oldBuffer.destroy).not.toHaveBeenCalled();
        expect(engine._retirements).toBeUndefined();

        blocked = false;
        processMaterialSwaps(scene);
        expect(rebuild).toHaveBeenCalledOnce();
        expect(reboundBuffer).toBe(buffers[1]);
        expect(engine._retirements).toHaveLength(1);

        const bindingRetirements = engine._retirements!;
        engine._retirements = null;
        bindingRetirements.splice(0).forEach((retire) => retire());
        expect(oldBuffer.destroy).not.toHaveBeenCalled();
        expect(engine._retirements).toHaveLength(1);

        const uboRetirements = engine._retirements!;
        engine._retirements = null;
        uboRetirements.splice(0).forEach((retire) => retire());
        expect(oldBuffer.destroy).toHaveBeenCalledOnce();
        expect(buffers[1]!.destroy).not.toHaveBeenCalled();
    });

    it("uses an active runtime rebuild's pending disposer packet when the scene map is empty", () => {
        const { engine, buffers } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const scene = pluginScene(engine, [material]);
        const targetMesh = scene.meshes[0]!;

        registerStdPlugins(scene, (ext) => {
            registered = ext;
        });
        const oldBuffer = buffers[0]!;
        const pendingDisposers: (() => void)[] = [];
        let reboundBuffer: GPUBuffer | undefined;
        const rebuild = vi.fn((targetScene: SceneContext) => {
            const entries: GPUBindGroupEntry[] = [];
            registered._bind!(material, entries, 0, targetMesh, targetScene);
            reboundBuffer = (entries[0]!.resource as GPUBufferBinding).buffer;
            return { mesh: targetMesh, order: 0, isTransparent: false } as Renderable;
        });
        scene._groups.set(material._buildGroup, Object.assign([targetMesh], { r: rebuild }));
        scene._renderables.push({ mesh: targetMesh, order: 0, isTransparent: false } as Renderable);
        scene._built = true;
        let blocked = true;
        scene._runtimeBuilds = {
            get w() {
                return blocked;
            },
            pendingDisposers: (mesh: Mesh) => (mesh === targetMesh ? pendingDisposers : undefined),
        } as unknown as RuntimeSceneBuildHooks;

        expect(scene._meshDisposables.get(targetMesh)).toBeUndefined();
        bakeStdPluginMaterial(material, scene);

        expect(pendingDisposers).toHaveLength(1);
        expect(engine._retirements).toBeUndefined();
        processMaterialSwaps(scene);
        expect(rebuild).not.toHaveBeenCalled();
        expect(oldBuffer.destroy).not.toHaveBeenCalled();

        blocked = false;
        scene._meshDisposables.set(targetMesh, []);
        engine._retirements = [() => pendingDisposers.splice(0).forEach((dispose) => dispose())];
        processMaterialSwaps(scene);

        expect(rebuild).toHaveBeenCalledOnce();
        expect(reboundBuffer).toBe(buffers[1]);
        const bindingRetirements = engine._retirements;
        engine._retirements = null;
        bindingRetirements?.splice(0).forEach((retire) => retire());
        expect(oldBuffer.destroy).not.toHaveBeenCalled();

        const uboRetirements = engine._retirements as (() => void)[] | null;
        engine._retirements = null;
        uboRetirements?.splice(0).forEach((retire) => retire());
        expect(oldBuffer.destroy).toHaveBeenCalledOnce();
    });

    it("keeps the old UBO alive during a blocked full-group rebuild with no scene disposer packet", async () => {
        const { engine, buffers } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const scene = pluginScene(engine, [material]);
        const targetMesh = scene.meshes[0]!;

        registerStdPlugins(scene, (ext) => {
            registered = ext;
        });
        const oldBuffer = buffers[0]!;
        const standardBuilder = material._buildGroup;
        let enterBuilder!: () => void;
        const enteredBuilder = new Promise<void>((resolve) => {
            enterBuilder = resolve;
        });
        let unblockBuilder!: () => void;
        const blockedBuilder = new Promise<void>((resolve) => {
            unblockBuilder = resolve;
        });
        let reboundBuffer: GPUBuffer | undefined;
        const builder = (async (targetScene: SceneContext) => {
            enterBuilder();
            await blockedBuilder;
            const entries: GPUBindGroupEntry[] = [];
            registered._bind!(material, entries, 0, targetMesh, targetScene);
            reboundBuffer = (entries[0]!.resource as GPUBufferBinding).buffer;
            targetScene._meshDisposables.set(targetMesh, []);
            return {
                renderables: [{ mesh: targetMesh, order: 0, isTransparent: false } as Renderable],
                rebuildSingle: () => ({ mesh: targetMesh, order: 0, isTransparent: false }) as Renderable,
            };
        }) as unknown as MeshGroupBuilder;
        Object.assign(material, { _buildGroup: builder });
        scene._groups.set(builder, [targetMesh]);
        scene._meshDisposables.set(targetMesh, []);
        scene._built = true;

        const rebuilding = rebuildSceneRenderables(scene);
        await enteredBuilder;
        expect(scene._meshDisposables.has(targetMesh)).toBe(false);
        expect(scene._runtimeBuilds?.pendingDisposers(targetMesh)).toBeDefined();

        Object.assign(material, { _buildGroup: standardBuilder });
        bakeStdPluginMaterial(material, scene);
        Object.assign(material, { _buildGroup: builder });
        expect(buffers).toHaveLength(2);
        expect(oldBuffer.destroy).not.toHaveBeenCalled();
        expect(engine._retirements).toBeUndefined();

        unblockBuilder();
        await rebuilding;
        expect(reboundBuffer).toBe(buffers[1]);
        expect(oldBuffer.destroy).not.toHaveBeenCalled();
        expect(engine._retirements).toHaveLength(1);

        const bindingRetirements = engine._retirements!;
        engine._retirements = null;
        bindingRetirements.splice(0).forEach((retire) => retire());
        expect(oldBuffer.destroy).not.toHaveBeenCalled();
        expect(engine._retirements).toHaveLength(1);

        const uboRetirements = engine._retirements!;
        engine._retirements = null;
        uboRetirements.splice(0).forEach((retire) => retire());
        expect(oldBuffer.destroy).toHaveBeenCalledOnce();
        expect(buffers[1]!.destroy).not.toHaveBeenCalled();
    });
});
