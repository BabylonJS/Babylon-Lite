import { describe, expect, it } from "vitest";
import { createRectAreaLight } from "../../../packages/babylon-lite/src/light/rect-area-light.js";
import { createPointLight } from "../../../packages/babylon-lite/src/light/point-light.js";
import { cloneTransformNode, createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node.js";
import { setParent } from "../../../packages/babylon-lite/src/scene/set-parent.js";
import { writeMeshLightSelection } from "../../../packages/babylon-lite/src/render/mesh-light-selection.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { applyLightFoOffset } from "../../../packages/babylon-lite/src/large-world/floating-origin.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene.js";
import { copyLightBase } from "../../../packages/babylon-lite/src/light/light-clone.js";

describe("RectAreaLight data", () => {
    it("copies caller-owned color tuples before tracking and preserves same-value writes", () => {
        const light = createRectAreaLight([0, 0, 0], 2, 2);
        const diffuse: [number, number, number] = [0.2, 0.3, 0.4];
        const specular: [number, number, number] = [0.5, 0.6, 0.7];
        light.diffuse = diffuse;
        light.specular = specular;
        const version = light._lightVersion;
        diffuse[0] = 9;
        specular[0] = 8;
        expect(light.diffuse).toEqual([0.2, 0.3, 0.4]);
        expect(light.specular).toEqual([0.5, 0.6, 0.7]);
        expect(light._lightVersion).toBe(version);
        light.diffuse[0] = 0.2;
        const sameSpecular = light.specular;
        light.specular = sameSpecular;
        expect(light._lightVersion).toBe(version);
        light.diffuse[0] = 0.1;
        expect(light._lightVersion).toBe(version + 1);
        expect(light._cloneNode!(copyLightBase).diffuse).not.toBe(light.diffuse);
    });
    it("packs center, independent colors, intensity and six half-axis scalars into exactly 64 bytes", () => {
        const light = createRectAreaLight([3, 4, 5], 6, 8, 2);
        light.diffuse = [0.2, 0.4, 0.6];
        light.specular = [0.3, 0.5, 0.7];
        const buffer = new Float32Array(24).fill(-7);
        light._writeLightUbo!(buffer, 4);
        expect(Array.from(buffer.slice(4, 8))).toEqual([3, 4, 5, 4]);
        expect(Array.from(buffer.slice(0, 4))).toEqual([-7, -7, -7, -7]);
        expect(Array.from(buffer.slice(20))).toEqual([-7, -7, -7, -7]);
        expect(buffer[11]).toBe(3);
        expect(buffer[15]).toBe(0);
        expect(Array.from(buffer.slice(16, 20))).toEqual([0, 0, 4, 0]);
        expect(buffer[8]).toBeCloseTo(0.4);
        expect(buffer[12]).toBeCloseTo(0.6);
        expect("scene" in light).toBe(false);
    });

    it("tracks direct scalar changes, replacement colors and tuple writes without dirtying transforms", () => {
        const light = createRectAreaLight([0, 0, 0], 2, 2);
        const worldVersion = light.worldMatrixVersion;
        const before = light._lightVersion;
        light.width = 3;
        light.height = 5;
        light.intensity = 2;
        light.diffuse = [0.4, 0.5, 0.6];
        light.specular[1] = 0.1;
        expect(light._lightVersion).toBe(before + 5);
        expect(light.worldMatrixVersion).toBe(worldVersion);
        light.width = 3;
        light.height = 5;
        light.specular[1] = 0.1;
        expect(light._lightVersion).toBe(before + 5);
        const buffer = new Float32Array(16);
        light._writeLightUbo!(buffer, 0);
        expect(buffer[7]).toBe(1.5);
        expect(buffer[14]).toBe(2.5);
        expect(buffer[9]).toBeCloseTo(0.2);
    });

    it("retains axis lengths under nonuniform parent scaling and rotates local -Z", () => {
        const light = createRectAreaLight([1, 2, 3], 4, 6);
        const parent = createTransformNode("parent");
        setParent(light, parent);
        const version = light._lightVersion;
        parent.scaling.set(2, 3, 4);
        parent.rotation.y = Math.PI / 2;
        parent.position.set(10, 20, 30);
        const data = new Float32Array(16);
        light._writeLightUbo!(data, 0);
        expect(light._lightVersion).toBeGreaterThan(version);
        expect(data[0]).toBeCloseTo(22);
        expect(data[1]).toBeCloseTo(26);
        expect(data[2]).toBeCloseTo(28);
        expect(data[7]).toBeCloseTo(0);
        expect(data[11]).toBeCloseTo(0);
        expect(data[12]).toBeCloseTo(-4);
        expect(data[13]).toBeCloseTo(0);
        expect(data[14]).toBeCloseTo(9);
        expect(data[15]).toBeCloseTo(0);
    });

    it("tracks own quaternion/scaling and preserves the world transform when reparenting", () => {
        const light = createRectAreaLight([1, 2, 3], 4, 6);
        light.scaling.set(2, 3, 1);
        light.rotation.z = Math.PI / 2;
        const before = Array.from(light.worldMatrix);
        const parent = createTransformNode("p", 2, 3, 4);
        setParent(light, parent);
        expect(Array.from(light.worldMatrix)).toEqual(before);
        const data = new Float32Array(16);
        light._writeLightUbo!(data, 0);
        expect(data[11]).toBeCloseTo(4);
        expect(data[13]).toBeCloseTo(-9);
        expect(data[14]).toBeCloseTo(0);
    });

    it("clones actual position, dimensions and nonzero intensity with independent colors and transforms", () => {
        const light = createRectAreaLight([7, 8, 9], 2.5, 3.5, 4);
        light.name = "rect";
        light.rotation.x = 0.3;
        light.scaling.set(1.5, 0.5, 2);
        light.diffuse = [0.1, 0.2, 0.3];
        light.specular = [0.4, 0.5, 0.6];
        light.includedOnlyMeshIds = new Set(["receiver"]);
        const clone = light._cloneNode!(copyLightBase);
        expect(clone).toMatchObject({ lightType: "rectArea", width: 2.5, height: 3.5, intensity: 4, name: "rect_clone" });
        expect(Array.from(clone.worldMatrix)).toEqual(Array.from(light.worldMatrix));
        expect(clone.includedOnlyMeshIds).toBe(light.includedOnlyMeshIds);
        clone.diffuse[0] = 1;
        clone.specular[1] = 1;
        clone.position.x = 100;
        expect(light.diffuse[0]).toBe(0.1);
        expect(light.specular[1]).toBe(0.5);
        expect(light.position.x).toBe(7);
        const parent = createTransformNode("tree");
        setParent(light, parent);
        const tree = cloneTransformNode(parent);
        expect(tree.children[0]).toMatchObject({ lightType: "rectArea", width: 2.5, height: 3.5, intensity: 4, parent: tree });
    });

    it("supports mixed-light inclusion/exclusion without changing selected packed indices", () => {
        const rect = createRectAreaLight([0, 0, 1], 2, 2);
        const point = createPointLight([0, 1, 0]);
        rect.includedOnlyMeshIds = new Set(["a"]);
        const a = { id: "a" } as Mesh;
        const b = { id: "b" } as Mesh;
        expect(writeMeshLightSelection(a, [rect, point])).toBe(-2);
        expect(writeMeshLightSelection(b, [rect, point])).toBe(2);
        rect.includedOnlyMeshIds = undefined;
        rect.excludedMeshIds = new Set(["a"]);
        expect(writeMeshLightSelection(a, [rect, point])).toBe(2);
        expect(writeMeshLightSelection(b, [rect, point])).toBe(-2);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects invalid dimensions/intensity %s but accepts collapsed zero", (value) => {
        expect(() => createRectAreaLight([0, 0, 0], value, 1)).toThrow(/width/);
        expect(() => createRectAreaLight([0, 0, 0], 1, value)).toThrow(/height/);
        expect(() => createRectAreaLight([0, 0, 0], 1, 1, value)).toThrow(/intensity/);
        const light = createRectAreaLight([0, 0, 0], 0, 0, 0);
        expect(() => (light.width = value)).toThrow(/width/);
        expect(light.width).toBe(0);
    });

    it("requires the explicit shader opt-in", () => {
        const light = createRectAreaLight([0, 0, 0], 1, 1);
        expect(() => light._validateLighting!(undefined)).toThrow(/enableRectAreaLights/);
    });

    it("floating origin offsets the world center without changing either half axis", () => {
        const light = createRectAreaLight([10, 20, 30], 4, 6);
        const data = new Float32Array(20);
        light._writeLightUbo!(data, 4);
        const before = data.slice(8);
        const camera = createTransformNode("eye", 8, 17, 26);
        applyLightFoOffset(data, { camera, lights: [light] } as unknown as SceneContext);
        expect(Array.from(data.slice(4, 8))).toEqual([2, 3, 4, 4]);
        expect(data.slice(8)).toEqual(before);
    });
});
