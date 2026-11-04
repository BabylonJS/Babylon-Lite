import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

describe("ShaderMaterial lazy external texture API", () => {
    it("preserves declarations created before the optional binding module loads", async () => {
        vi.resetModules();
        const [{ createShaderMaterial }, { getOrCreateShaderPipelineBindings }, { wgsl }] = await Promise.all([
            import("../../../packages/babylon-lite/src/material/shader/shader-material"),
            import("../../../packages/babylon-lite/src/material/shader/shader-pipeline"),
            import("../../../packages/babylon-lite/src/shader/wgsl"),
        ]);
        const externalTextures = ["videoSampler"];
        const material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position"],
            externalTextures,
        });
        externalTextures[0] = "otherVideo";

        expect(material._externalTextureDecls).toEqual(["videoSampler"]);
        expect(material._externalTextureSlots).toBeUndefined();

        const createBindGroupLayout = vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout);
        const engine = {
            _device: {
                createBindGroupLayout,
                createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
            },
        } as unknown as EngineContext;
        expect(() => getOrCreateShaderPipelineBindings(engine, material)).toThrow("require setShaderExternalTexture");
        expect(createBindGroupLayout).not.toHaveBeenCalled();

        const [{ createExternalTexture }, { getShaderExternalTexture, setShaderExternalTexture }] = await Promise.all([
            import("../../../packages/babylon-lite/src/texture/external-texture"),
            import("../../../packages/babylon-lite/src/material/shader/shader-external-texture"),
        ]);
        expect(() => getOrCreateShaderPipelineBindings(engine, material)).toThrow("require setShaderExternalTexture");
        expect(createBindGroupLayout).not.toHaveBeenCalled();
        const video = { HAVE_CURRENT_DATA: 2, readyState: 2 } as HTMLVideoElement;
        const texture = createExternalTexture(video);

        setShaderExternalTexture(material, "videoSampler", texture);
        expect(getShaderExternalTexture(material, "videoSampler")).toBe(texture);
        getOrCreateShaderPipelineBindings(engine, material);
        const layout = createBindGroupLayout.mock.calls.map((call) => call[0]).find((descriptor) => descriptor.label === "shader-material-group1");
        expect(layout?.entries).toEqual([
            { binding: 0, visibility: 3, buffer: { type: "uniform" } },
            { binding: 1, visibility: 3, externalTexture: {} },
            { binding: 2, visibility: 3, sampler: { type: "filtering" } },
        ]);
    });
});
