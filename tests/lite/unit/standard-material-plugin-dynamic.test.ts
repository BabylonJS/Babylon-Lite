import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { enableMaterialPlugins } from "../../../packages/babylon-lite/src/material/plugin/enable-material-plugins";
import type { MaterialPlugin } from "../../../packages/babylon-lite/src/material/plugin/material-plugin";
import { bakeStdPluginMaterial, refreshStdPluginUbos, registerStdPlugins } from "../../../packages/babylon-lite/src/material/plugin/std-plugin-bridge";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { StdExt } from "../../../packages/babylon-lite/src/material/standard/standard-flags";
import { createSceneContext, disposeScene, onBeforeRender, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

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
        registered._bind!(materialA, entriesA, 0, undefined, engine);
        registered._bind!(materialB, entriesB, 0, undefined, engine);
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
        registered._bind!(material, entries, 0, undefined, engine);

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

    it("retires the previous plugin UBO when a material is baked again", () => {
        const { engine, buffers } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];
        const scene = pluginScene(engine, [material]);

        enableMaterialPlugins(scene);
        const oldBuffer = buffers[0]!;
        scene._built = true;
        bakeStdPluginMaterial(material, scene);

        expect(buffers).toHaveLength(2);
        expect(oldBuffer.destroy).not.toHaveBeenCalled();
        expect(engine._retirements).toHaveLength(1);
        engine._retirements!.splice(0).forEach((retire) => retire());
        expect(oldBuffer.destroy).toHaveBeenCalledOnce();
        expect(buffers[1]!.destroy).not.toHaveBeenCalled();
    });
});
