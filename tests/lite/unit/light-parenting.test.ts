import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createSpotLight } from "../../../packages/babylon-lite/src/light/spot-light";
import { refreshSceneLightsUBO } from "../../../packages/babylon-lite/src/render/lights-ubo";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { setParent } from "../../../packages/babylon-lite/src/scene/set-parent";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { _computeSpotLightMatrix } from "../../../packages/babylon-lite/src/shadow/pcf-spotlight-shadow-generator";

function snapshot(matrix: Mat4): number[] {
    return Array.from(matrix);
}

function expectMatrixClose(actual: Mat4, expected: ArrayLike<number>): void {
    for (let i = 0; i < 16; i++) {
        expect(actual[i]).toBeCloseTo(expected[i]!, 5);
    }
}

describe("light SceneNode parenting", () => {
    it("reparents a spotlight without losing its world transform", () => {
        const light = createSpotLight([1, 2, 3], [0, 0, 1], Math.PI / 3, 2);
        const parent = createTransformNode("drone", 4, -2, 7, 0, Math.SQRT1_2, 0, Math.SQRT1_2);
        const before = snapshot(light.worldMatrix);

        setParent(light, parent);

        expect(light.parent).toBe(parent);
        expect(parent.children).not.toContain(light);
        expectMatrixClose(light.worldMatrix, before);

        setParent(light, null);

        expect(light.parent).toBeNull();
        expect(parent.children).not.toContain(light);
        expectMatrixClose(light.worldMatrix, before);
    });

    it("keeps the rendered direction normalized under a scaled parent", () => {
        const light = createSpotLight([0, 0, 0], [0, 0, 1], Math.PI / 3, 2);
        const parent = createTransformNode("scaled", 0, 0, 0, 0, 0, 0, 1, 0.5, 0.5, 0.5);
        const data = new Float32Array(16);

        setParent(light, parent);
        light._writeLightUbo!(data, 0);

        expect(data[12]).toBeCloseTo(0);
        expect(data[13]).toBeCloseTo(0);
        expect(data[14]).toBeCloseTo(1);

        setParent(light, null);
        light._writeLightUbo!(data, 0);

        expect(data[12]).toBeCloseTo(0);
        expect(data[13]).toBeCloseTo(0);
        expect(data[14]).toBeCloseTo(1);
    });

    it("inherits later parent motion and rotation", () => {
        const light = createSpotLight([1, 2, 3], [0, 0, 1], Math.PI / 3, 2);
        const parent = createTransformNode("drone");
        setParent(light, parent);

        parent.position.set(10, 0, 0);
        parent.rotationQuaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);

        const world = light.worldMatrix;
        expect(world[12]).toBeCloseTo(13);
        expect(world[13]).toBeCloseTo(2);
        expect(world[14]).toBeCloseTo(-1);
        expect(world[8]).toBeCloseTo(1);
        expect(world[9]).toBeCloseTo(0);
        expect(world[10]).toBeCloseTo(0);

        const expected = createSpotLight([13, 2, -1], [1, 0, 0], Math.PI / 3, 2);
        expectMatrixClose(_computeSpotLightMatrix(light, 0.1, 100)._view as unknown as Mat4, _computeSpotLightMatrix(expected, 0.1, 100)._view as unknown as Mat4);
    });

    it("refreshes the scene light UBO after parent motion", () => {
        const writeBuffer = vi.fn();
        const engine = {
            _device: {
                createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
                queue: { writeBuffer },
            },
        } as unknown as EngineContext;
        const light = createSpotLight([1, 2, 3], [0, 0, 1], Math.PI / 3, 2);
        const parent = createTransformNode("drone");
        const scene = { lights: [light], _disposables: [] } as unknown as SceneContext;
        setParent(light, parent);
        refreshSceneLightsUBO(engine, scene);
        writeBuffer.mockClear();

        parent.position.set(10, 0, 0);
        parent.rotationQuaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);
        refreshSceneLightsUBO(engine, scene);

        expect(writeBuffer).toHaveBeenCalledTimes(1);
        const data = scene._lightGpuState!._scratch;
        expect(data[4]).toBeCloseTo(13);
        expect(data[5]).toBeCloseTo(2);
        expect(data[6]).toBeCloseTo(-1);
        expect(data[16]).toBeCloseTo(1);
        expect(data[17]).toBeCloseTo(0);
        expect(data[18]).toBeCloseTo(0);
    });

    it("preserves the spotlight shadow view across attach and detach", () => {
        const light = createSpotLight([1, 2, 3], [0, 0, 1], Math.PI / 3, 2);
        const parent = createTransformNode("drone", 4, -2, 7, 0, Math.SQRT1_2, 0, Math.SQRT1_2);
        const before = snapshot(_computeSpotLightMatrix(light, 0.1, 100)._view as unknown as Mat4);

        setParent(light, parent);
        expectMatrixClose(_computeSpotLightMatrix(light, 0.1, 100)._view as unknown as Mat4, before);

        setParent(light, null);
        expectMatrixClose(_computeSpotLightMatrix(light, 0.1, 100)._view as unknown as Mat4, before);
    });
});
