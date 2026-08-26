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
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { createSceneContext, disposeScene, onBeforeRender, type RuntimeSceneBuildHooks, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap";

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
    return { material } as unknown as Mesh;
}

function pluginScene(engine: EngineContext, materials: StandardMaterialProps[]): SceneContext {
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.meshes.push(...materials.map(mesh));
    return scene;
}

describe("dynamic Standard material plugins", () => {
    let registered: StdExt;

    beforeEach(() => {
        registered = undefined as unknown as StdExt;
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
        registered._bind!(material, entries, 0, undefined, scene);

        expect(entries).toHaveLength(1);
        expect(material._renderFeatures?.features).not.toBe(0);
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
});
