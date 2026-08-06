import { describe, expect, it, vi } from "vitest";

import { getCsmReceiverTexture, onCsmReceiverUpdate } from "../../../packages/babylon-lite/src/shadow/csm-directional-shadow-generator";
import { acquireTexture, releaseTexture } from "../../../packages/babylon-lite/src/resource/gpu-pool";
import type { CsmTaskState } from "../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

function fakeShadowGenerator(type: ShadowGenerator["_shadowType"] = "csm") {
    const view = { label: "csm-array-view" };
    const texture = {
        width: 2048,
        height: 2048,
        createView: vi.fn(() => view),
        destroy: vi.fn(),
    };
    const sampler = { label: "csm-comparison-sampler" };
    const generator = {
        _shadowType: type,
        _depthTexture: texture,
        _depthSampler: sampler,
    } as unknown as ShadowGenerator;
    return { generator, texture, sampler, view };
}

describe("CSM receiver texture", () => {
    it("creates one stable borrowed 2d-array depth wrapper", () => {
        const { generator, texture, sampler, view } = fakeShadowGenerator();

        const first = getCsmReceiverTexture(generator);
        const second = getCsmReceiverTexture(generator);

        expect(first).toBe(second);
        expect(first.texture).toBe(texture);
        expect(first.view).toBe(view);
        expect(first.sampler).toBe(sampler);
        expect(first.width).toBe(2048);
        expect(first.height).toBe(2048);
        expect(first._sampleType).toBe("depth");
        expect(texture.createView).toHaveBeenCalledTimes(1);
        expect(texture.createView).toHaveBeenCalledWith({ dimension: "2d-array" });
    });

    it("retains generator ownership across a ShaderMaterial acquire/release cycle", () => {
        const { generator, texture } = fakeShadowGenerator();
        const receiverTexture = getCsmReceiverTexture(generator);

        acquireTexture(receiverTexture);
        expect(releaseTexture(receiverTexture)).toBe(false);
        expect(texture.destroy).not.toHaveBeenCalled();
    });

    it.each(["esm", "pcf"] as const)("rejects a %s generator", (type) => {
        const { generator, texture } = fakeShadowGenerator(type);

        expect(() => getCsmReceiverTexture(generator)).toThrow("requires a CSM shadow generator");
        expect(texture.createView).not.toHaveBeenCalled();
    });

    it("replays the last receiver data to a late subscriber", () => {
        const { generator } = fakeShadowGenerator();
        const data = new Float32Array(80);
        data[76] = 4;
        generator._shadowTaskState = { _uboData: data, _cameraVersion: 1 } as CsmTaskState;
        const callback = vi.fn();

        const dispose = onCsmReceiverUpdate(generator, callback);

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith(data);
        dispose();
        expect(generator._onReceiverData).toEqual([]);
    });
});
