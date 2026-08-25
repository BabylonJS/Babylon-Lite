import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { enableMaterialPlugins } from "../../../packages/babylon-lite/src/material/plugin/enable-material-plugins";
import type { MaterialPlugin } from "../../../packages/babylon-lite/src/material/plugin/material-plugin";
import { bakeStdPluginMaterial, refreshStdPluginUbos, registerStdPlugins } from "../../../packages/babylon-lite/src/material/plugin/std-plugin-bridge";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { StdExt } from "../../../packages/babylon-lite/src/material/standard/standard-flags";
import { onBeforeRender, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

function makeEngine(onWrite?: () => void): { engine: EngineContext; createBuffer: ReturnType<typeof vi.fn>; writeBuffer: ReturnType<typeof vi.fn>; uploadedValues: number[] } {
    const uploadedValues: number[] = [];
    const writeBuffer = vi.fn((_target: GPUBuffer, _targetOffset: number, source: ArrayBuffer, sourceOffset: number) => {
        onWrite?.();
        uploadedValues.push(new Float32Array(source, sourceOffset, 1)[0]!);
    });
    let bufferId = 0;
    const createBuffer = vi.fn(() => ({ id: ++bufferId }) as unknown as GPUBuffer);
    const device = {
        createBuffer,
        queue: { writeBuffer },
    } as unknown as GPUDevice;
    return { engine: { _device: device } as unknown as EngineContext, createBuffer, writeBuffer, uploadedValues };
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

        registerStdPlugins([mesh(materialA), mesh(materialB)], engine, (ext) => {
            registered = ext;
        });

        const entriesA: GPUBindGroupEntry[] = [];
        const entriesB: GPUBindGroupEntry[] = [];
        registered._bind!(materialA, entriesA, 0);
        registered._bind!(materialB, entriesB, 0);
        expect((entriesA[0]!.resource as GPUBufferBinding).buffer).not.toBe((entriesB[0]!.resource as GPUBufferBinding).buffer);
        expect(uploadedValues).toEqual([1, 2]);

        valueA.current = 3;
        valueB.current = 4;
        writeBuffer.mockClear();
        uploadedValues.length = 0;
        refreshStdPluginUbos(engine);

        expect(uploadedValues).toEqual([3, 4]);
    });

    it("bakes a Standard material created after initial registration", () => {
        const { engine } = makeEngine();
        registerStdPlugins([], engine, (ext) => {
            registered = ext;
        });
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 5 }, false)];

        bakeStdPluginMaterial(material, engine);
        const entries: GPUBindGroupEntry[] = [];
        registered._bind!(material, entries, 0);

        expect(entries).toHaveLength(1);
        expect(material._renderFeatures?.features).not.toBe(0);
    });

    it("bakes a material shared by multiple meshes only once", () => {
        const { engine, createBuffer } = makeEngine();
        const material = createStandardMaterial();
        material.plugins = [valuePlugin({ current: 1 })];

        registerStdPlugins([mesh(material), mesh(material)], engine, (ext) => {
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
        const scene = {
            surface: { engine },
            meshes: [mesh(material)],
            _beforeRender: [
                () => {
                    order.push("existing");
                    value.current = 2;
                },
            ],
        } as unknown as SceneContext;

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
});
