import { describe, expect, it } from "vitest";

import { GPUPicker } from "../src/picking/gpu-picker";
import { LiteCompatError } from "../src/error";
import { Mesh } from "../src/meshes/meshes";

describe("GPUPicker (GPU-free paths)", () => {
    it("starts idle with no picker", () => {
        const picker = new GPUPicker();
        expect(picker.pickingInProgress).toBe(false);
    });

    it("returns null from pickAsync before any list is set", async () => {
        const picker = new GPUPicker();
        await expect(picker.pickAsync(0, 0)).resolves.toBeNull();
    });

    it("returns null from multiPickAsync with no list", async () => {
        const picker = new GPUPicker();
        await expect(picker.multiPickAsync([{ x: 0, y: 0 }])).resolves.toBeNull();
    });

    it("clears the picking list without error", () => {
        const picker = new GPUPicker();
        expect(() => picker.setPickingList(null)).not.toThrow();
        expect(() => picker.clearPickingList()).not.toThrow();
    });

    it("throws a clear error when picking-list meshes have no scene", () => {
        const picker = new GPUPicker();
        // A Mesh constructed without a scene argument carries no scene reference.
        const sceneless = Object.create(Mesh.prototype) as Mesh;
        (sceneless as unknown as { _lite: unknown })._lite = {};
        Object.defineProperty(sceneless, "getScene", { value: () => undefined });

        expect(() => picker.setPickingList([sceneless])).toThrow(LiteCompatError);
        expect(() => picker.setPickingList([sceneless])).toThrow(/GPUPicker.setPickingList/);
    });

    it("boxPickAsync throws LiteCompatError", () => {
        const picker = new GPUPicker();
        expect(() => picker.boxPickAsync()).toThrow(LiteCompatError);
        expect(() => picker.boxPickAsync()).toThrow(/boxPickAsync/);
    });

    it("dispose is safe to call repeatedly", () => {
        const picker = new GPUPicker();
        expect(() => {
            picker.dispose();
            picker.dispose();
        }).not.toThrow();
    });
});
