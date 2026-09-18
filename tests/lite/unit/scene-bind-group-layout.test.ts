import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { getSceneBindGroupLayout } from "../../../packages/babylon-lite/src/render/scene-helpers";
import { clearStandardPipelineCache } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";

function engine() {
    const createBindGroupLayout = vi.fn(() => ({}) as GPUBindGroupLayout);
    const value = { _device: { createBindGroupLayout } } as unknown as EngineContext;
    return { value, createBindGroupLayout };
}

describe("scene bind-group layout ownership", () => {
    it("shares immutable layouts by device without cross-engine invalidation", () => {
        const first = engine();
        const second = engine();
        const a = getSceneBindGroupLayout(first.value);
        const b = getSceneBindGroupLayout(second.value);
        expect(a).not.toBe(b);
        expect(getSceneBindGroupLayout(first.value)).toBe(a);
        expect(getSceneBindGroupLayout(second.value)).toBe(b);
        expect(first.createBindGroupLayout).toHaveBeenCalledOnce();
        expect(second.createBindGroupLayout).toHaveBeenCalledOnce();
        clearStandardPipelineCache();
        expect(getSceneBindGroupLayout(first.value)).toBe(a);
        expect(getSceneBindGroupLayout({ _device: first.value._device } as EngineContext)).toBe(a);
    });

    it("does not publish a new device cache entry when layout creation fails", () => {
        const first = engine();
        const replacement = engine();
        const original = getSceneBindGroupLayout(first.value);
        first.value._device = replacement.value._device;
        replacement.createBindGroupLayout.mockImplementationOnce(() => {
            throw new Error("layout allocation failed");
        });

        expect(() => getSceneBindGroupLayout(first.value)).toThrow("layout allocation failed");
        const rebuilt = getSceneBindGroupLayout(first.value);
        expect(rebuilt).not.toBe(original);
        expect(getSceneBindGroupLayout(replacement.value)).toBe(rebuilt);
        expect(replacement.createBindGroupLayout).toHaveBeenCalledTimes(2);
    });
});
