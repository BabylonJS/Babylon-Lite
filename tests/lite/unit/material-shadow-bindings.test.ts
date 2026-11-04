import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import { createMaterialShadowBindings } from "../../../packages/babylon-lite/src/shadow/material-shadow-bindings";
import { createStandardShadowContext } from "../../../packages/babylon-lite/src/material/standard/fragments/std-shadow-fragment";
import { createMaterialShadowBindings as createPbrBindings } from "../../../packages/babylon-lite/src/material/pbr/fragments/pbr-shadow-fragment";

function generator(type: "esm" | "pcf" = "esm"): ShadowGenerator {
    return {
        _shadowType: type,
        _depthTexture: { createView: vi.fn(() => ({}) as GPUTextureView) },
        _depthSampler: {} as GPUSampler,
        _shadowUBO: {} as GPUBuffer,
    } as unknown as ShadowGenerator;
}

function engine(): EngineContext {
    return {
        _device: { createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ descriptor }) as unknown as GPUBindGroup) },
    } as unknown as EngineContext;
}

describe("optional material shadow bindings", () => {
    it("exposes the shared implementation through the PBR receiver module", () => {
        expect(createPbrBindings).toBe(createMaterialShadowBindings);
    });

    it("captures Standard scene slots once and reuses the immutable receiver fragment", async () => {
        const eng = engine();
        const first = generator();
        const second = generator("pcf");
        const context = await createStandardShadowContext(eng, [{ shadowGenerator: first }, {}, { shadowGenerator: second }]);
        expect(context._key).toBe("0e,2p");
        expect(eng._device.createBindGroup).not.toHaveBeenCalled();
        const fragment = context._fragment();
        expect(context._fragment()).toBe(fragment);
        expect(fragment._bindings?.map((binding) => binding._name)).toEqual(["shadowTex_0", "shadowSamp_0", "shadowInfo_0", "shadowTex_2", "shadowComp_2", "shadowInfo_2"]);
        const layout = {} as GPUBindGroupLayout;
        expect(context._bindings(layout)).toBe(context._bindings(layout));
        expect(eng._device.createBindGroup).toHaveBeenCalledOnce();
    });

    it("preserves ordered texture/sampler/uniform triples and caches each layout", () => {
        const eng = engine();
        const first = generator();
        const second = generator();
        const bind = createMaterialShadowBindings(eng, [{ gen: first }, { gen: second }]);
        const layout = {} as GPUBindGroupLayout;
        expect(eng._device.createBindGroup).not.toHaveBeenCalled();

        const group = bind(layout);

        expect(bind(layout)).toBe(group);
        expect(eng._device.createBindGroup).toHaveBeenCalledExactlyOnceWith({
            layout,
            entries: [
                { binding: 0, resource: vi.mocked(first._depthTexture.createView).mock.results[0]!.value },
                { binding: 1, resource: first._depthSampler },
                { binding: 2, resource: { buffer: first._shadowUBO } },
                { binding: 3, resource: vi.mocked(second._depthTexture.createView).mock.results[0]!.value },
                { binding: 4, resource: second._depthSampler },
                { binding: 5, resource: { buffer: second._shadowUBO } },
            ],
        });
        const another = {} as GPUBindGroupLayout;
        expect(bind(another)).not.toBe(group);
        expect(first._depthTexture.createView).toHaveBeenCalledTimes(2);
        expect(second._depthTexture.createView).toHaveBeenCalledTimes(2);
    });

    it("does not share cached groups between scenes that reuse a layout", () => {
        const eng = engine();
        const first = generator();
        const second = generator();
        const layout = {} as GPUBindGroupLayout;
        const bindFirst = createMaterialShadowBindings(eng, [{ gen: first }]);
        const bindSecond = createMaterialShadowBindings(eng, [{ gen: second }]);

        expect(bindFirst(layout)).not.toBe(bindSecond(layout));
        expect(eng._device.createBindGroup).toHaveBeenCalledTimes(2);
        expect(first._depthTexture.createView).toHaveBeenCalledOnce();
        expect(second._depthTexture.createView).toHaveBeenCalledOnce();
    });

    it("leaves the cache retryable when bind-group creation fails", () => {
        const eng = engine();
        const gen = generator();
        const bind = createMaterialShadowBindings(eng, [{ gen }]);
        const layout = {} as GPUBindGroupLayout;
        const failure = new Error("shadow binding failed");
        vi.mocked(eng._device.createBindGroup).mockImplementationOnce(() => {
            throw failure;
        });

        expect(() => bind(layout)).toThrow(failure);
        const group = bind(layout);
        expect(bind(layout)).toBe(group);
        expect(eng._device.createBindGroup).toHaveBeenCalledTimes(2);
    });
});
