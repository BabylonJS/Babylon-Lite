import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { disposeEngine } from "../../../packages/babylon-lite/src/engine/engine-dispose";
import { createComputeBindingSet, _ensureComputeBindingGroups } from "../../../packages/babylon-lite/src/compute/compute-bindings";
import { computeSamplerBinding } from "../../../packages/babylon-lite/src/compute/compute-sampler-binding";
import { createComputeShader } from "../../../packages/babylon-lite/src/compute/compute-shader";
import { computeStorageBufferBinding } from "../../../packages/babylon-lite/src/compute/compute-storage-buffer-binding";
import { computeStorageTextureBinding } from "../../../packages/babylon-lite/src/compute/compute-storage-texture-binding";
import { computeStorageTextureViewBinding } from "../../../packages/babylon-lite/src/compute/compute-storage-texture-view-binding";
import { computeTextureBinding } from "../../../packages/babylon-lite/src/compute/compute-texture-binding";
import { createComputeTextureResource } from "../../../packages/babylon-lite/src/compute/compute-texture-resource";
import { computeTextureViewBinding } from "../../../packages/babylon-lite/src/compute/compute-texture-view-binding";
import { createComputeTextureViewResource } from "../../../packages/babylon-lite/src/compute/compute-texture-view-resource";
import { createComputeSampler } from "../../../packages/babylon-lite/src/compute/compute-sampler-resource";
import { computeUniformBufferBinding } from "../../../packages/babylon-lite/src/compute/compute-uniform-buffer-binding";
import { cloneComputeStorageTexture2D, createComputeStorageTexture2D, disposeComputeStorageTexture2D } from "../../../packages/babylon-lite/src/resource/compute-storage-texture";
import { createComputeStorageTexture, disposeComputeStorageTexture } from "../../../packages/babylon-lite/src/resource/compute-storage-texture-view";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import { createUniformBuffer } from "../../../packages/babylon-lite/src/compute/compute-uniform-buffer";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import { createDepthPyramid } from "../../../packages/babylon-lite/src/frame-graph/depth-pyramid";
import { createComputeStorageTextureMipmapsTask } from "../../../packages/babylon-lite/src/compute/compute-storage-texture-mipmaps";
import { acquireTexture, releaseTexture } from "../../../packages/babylon-lite/src/resource/gpu-pool";

const gpuGlobals = globalThis as unknown as Omit<typeof globalThis, "GPUBufferUsage" | "GPUShaderStage" | "GPUTextureUsage"> & {
    GPUBufferUsage?: Record<string, number>;
    GPUShaderStage?: Record<string, number>;
    GPUTextureUsage?: Record<string, number>;
};
gpuGlobals.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100, UNIFORM: 0x40, STORAGE: 0x80 };
gpuGlobals.GPUShaderStage ??= { COMPUTE: 4 };
gpuGlobals.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };

function makeEngine(features: string[] = []) {
    const layouts: GPUBindGroupLayoutDescriptor[] = [];
    const groups: GPUBindGroupDescriptor[] = [];
    const textures: GPUTexture[] = [];
    let validationError: GPUError | null = null;
    const device = {
        features: new Set(features),
        limits: {
            maxBufferSize: 256 * 1024 * 1024,
            maxBindGroups: 4,
            maxBindingsPerBindGroup: 16,
            maxUniformBuffersPerShaderStage: 8,
            maxStorageBuffersPerShaderStage: 8,
            maxDynamicUniformBuffersPerPipelineLayout: 8,
            maxDynamicStorageBuffersPerPipelineLayout: 4,
            maxUniformBufferBindingSize: 65536,
            maxStorageBufferBindingSize: 1 << 20,
            maxSampledTexturesPerShaderStage: 16,
            maxSamplersPerShaderStage: 16,
            maxStorageTexturesPerShaderStage: 8,
            minUniformBufferOffsetAlignment: 256,
            minStorageBufferOffsetAlignment: 256,
            maxTextureDimension2D: 4096,
            maxTextureDimension1D: 8192,
            maxTextureDimension3D: 2048,
            maxTextureArrayLayers: 256,
        },
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const mapped = new ArrayBuffer(Number(descriptor.size));
            return {
                descriptor,
                getMappedRange: () => mapped,
                unmap: vi.fn(),
                destroy: vi.fn(),
            } as unknown as GPUBuffer;
        }),
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            const texture = {
                descriptor,
                format: descriptor.format,
                sampleCount: descriptor.sampleCount ?? 1,
                mipLevelCount: descriptor.mipLevelCount ?? 1,
                usage: descriptor.usage,
                createView: vi.fn(() => ({ texture, _device: device }) as unknown as GPUTextureView),
                destroy: vi.fn(),
            } as unknown as GPUTexture;
            textures.push(texture);
            return texture;
        }),
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor = {}) => ({ descriptor }) as unknown as GPUSampler),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => {
            layouts.push(descriptor);
            return descriptor as unknown as GPUBindGroupLayout;
        }),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
            groups.push(descriptor);
            for (const entry of descriptor.entries) {
                const resource = entry.resource as GPUTextureView & { _device?: GPUDevice };
                if (resource._device && resource._device !== device) {
                    validationError = { message: "foreign device texture" } as GPUError;
                }
            }
            return descriptor as unknown as GPUBindGroup;
        }),
        pushErrorScope: vi.fn(() => {
            validationError = null;
        }),
        popErrorScope: vi.fn(async () => validationError),
        queue: { writeBuffer: vi.fn() },
        destroy: vi.fn(),
    } as unknown as GPUDevice;
    const engine = { _device: device } as unknown as EngineContext;
    return { engine, device, layouts, groups, textures };
}

function ordinaryTexture(engine: EngineContext, format: GPUTextureFormat = "rgba8unorm", sampleCount = 1): Texture2D {
    const texture = engine._device.createTexture({
        size: { width: 4, height: 4 },
        format,
        sampleCount,
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const result: Texture2D = {
        texture,
        view: texture.createView(),
        sampler: engine._device.createSampler(),
        width: 4,
        height: 4,
    };
    return result;
}

describe("compute texture bindings", () => {
    it("reports one draw for every regenerated storage-texture mip level", async () => {
        const { engine } = makeEngine();
        const pass = {
            setPipeline: vi.fn(),
            setBindGroup: vi.fn(),
            draw: vi.fn(),
            end: vi.fn(),
        } as unknown as GPURenderPassEncoder;
        const beginRenderPass = vi.fn(() => pass);
        engine._currentEncoder = { beginRenderPass } as unknown as GPUCommandEncoder;
        const first = await createComputeStorageTexture(engine, {
            width: 8,
            height: 8,
            viewDimension: "2d",
            format: "rgba8unorm",
            sampled: true,
            mipMaps: true,
        });
        const second = await createComputeStorageTexture(engine, {
            width: 4,
            height: 4,
            viewDimension: "2d",
            format: "rgba8unorm",
            sampled: true,
            mipMaps: true,
        });
        const task = createComputeStorageTextureMipmapsTask("mips", [first, second]);

        expect(task.execute!()).toBe(5);
        expect(beginRenderPass).toHaveBeenCalledTimes(5);
        expect(pass.draw).toHaveBeenCalledTimes(5);

        task.dispose();
        disposeComputeStorageTexture(first);
        disposeComputeStorageTexture(second);
    });

    it.each([false, true])("requires explicit texture-formats-tier1 for rgba8snorm render mipmaps (enabled=%s)", async (enabled) => {
        const { engine, device } = makeEngine(enabled ? ["texture-formats-tier1"] : []);
        const features = [...device.features];
        const resource = await createComputeStorageTexture(engine, {
            width: 4,
            height: 4,
            viewDimension: "2d",
            format: "rgba8snorm",
            mipMaps: true,
        });
        expect(resource._texture.mipLevelCount).toBe(3);
        expect(!!(resource._texture.usage & GPUTextureUsage.RENDER_ATTACHMENT)).toBe(enabled);
        expect([...device.features]).toEqual(features);
        if (enabled) {
            createComputeStorageTextureMipmapsTask("snorm-mips", [resource]).dispose();
        } else {
            expect(() => createComputeStorageTextureMipmapsTask("snorm-mips", [resource])).toThrow(/texture-formats-tier1/);
        }
        disposeComputeStorageTexture(resource);
    });

    it("combines storage buffers, UBOs, textures, samplers, and storage textures in one shader", async () => {
        const { engine, layouts, groups } = makeEngine();
        const inputTexture = await createComputeTextureResource(engine, ordinaryTexture(engine));
        const inputSampler = createComputeSampler(engine, { minFilter: "linear", magFilter: "linear" });
        const outputTexture = createComputeStorageTexture2D(engine, { width: 8, height: 8, format: "rgba8unorm" });
        expect(outputTexture.sampledTexture.invertY).toBe(true);
        const shader = createComputeShader(engine, {
            computeSource: `@compute @workgroup_size(1) fn main() {}`,
            bindings: [
                computeUniformBufferBinding("params", { group: 0, binding: 0, minBindingSize: 16 }),
                computeStorageBufferBinding("data", { group: 0, binding: 1 }),
                computeTextureBinding("source", { group: 1, binding: 0 }),
                computeSamplerBinding("sourceSampler", { group: 1, binding: 1 }),
                computeStorageTextureBinding("output", { group: 1, binding: 2, format: "rgba8unorm" }),
            ],
        });

        const bindings = createComputeBindingSet(shader, {
            params: createUniformBuffer(engine, 16),
            data: createStorageBuffer(engine, new Float32Array(4)),
            source: inputTexture,
            sourceSampler: inputSampler,
            output: outputTexture,
        });

        const shaderLayouts = layouts.filter((layout) => String(layout.label).startsWith("compute-group"));
        const shaderGroups = groups.filter((group) => String(group.label).startsWith("compute-bindings"));
        expect(shaderLayouts).toHaveLength(2);
        expect(shaderLayouts[0]!.entries).toHaveLength(2);
        expect(shaderLayouts[1]!.entries).toHaveLength(3);
        expect(shaderGroups).toHaveLength(2);
        expect(bindings._groups).toHaveLength(2);
    });

    it("adapts explicit array and 3D sampled views without changing the compact 2D helper", async () => {
        const { engine } = makeEngine();
        const arrayTexture = { ...ordinaryTexture(engine), layers: 4 };
        const volumeTexture = { ...ordinaryTexture(engine), depth: 8 };
        const arrayResource = await createComputeTextureViewResource(engine, arrayTexture, { viewDimension: "2d-array" });
        const volumeResource = await createComputeTextureViewResource(engine, volumeTexture, { viewDimension: "3d" });

        expect(arrayResource.viewDimension).toBe("2d-array");
        expect(volumeResource.viewDimension).toBe("3d");

        const shader = createComputeShader(engine, {
            computeSource: `@compute @workgroup_size(1) fn main() {}`,
            bindings: [
                computeTextureViewBinding("arrayTexture", { group: 0, binding: 0, viewDimension: "2d-array" }),
                computeTextureViewBinding("volumeTexture", { group: 0, binding: 1, viewDimension: "3d" }),
            ],
        });
        expect(() => createComputeBindingSet(shader, { arrayTexture: arrayResource, volumeTexture: volumeResource })).not.toThrow();
        await expect(createComputeTextureResource(engine, arrayTexture)).rejects.toThrow(/only 2D/);
    });

    it("creates advanced storage dimensions and validates access at the binding boundary", async () => {
        const { engine } = makeEngine();
        const volume = await createComputeStorageTexture(engine, {
            width: 8,
            height: 4,
            depthOrArrayLayers: 2,
            viewDimension: "3d",
            format: "rgba8unorm",
            access: ["read-only", "read-write"],
            sampler: { addressModeU: "repeat", minFilter: "linear" },
        });
        expect(volume.viewDimension).toBe("3d");
        expect(volume.sampledTexture && "depth" in volume.sampledTexture ? volume.sampledTexture.depth : 0).toBe(2);
        expect(volume.computeTexture?.viewDimension).toBe("3d");
        expect(engine._device.createSampler).toHaveBeenCalledWith({ addressModeU: "repeat", minFilter: "linear" });

        const shader = createComputeShader(engine, {
            computeSource: `@compute @workgroup_size(1) fn main() {}`,
            bindings: [
                computeStorageTextureViewBinding("volume", {
                    group: 0,
                    binding: 0,
                    format: "rgba8unorm",
                    access: "read-write",
                    viewDimension: "3d",
                }),
            ],
        });
        expect(() => createComputeBindingSet(shader, { volume })).not.toThrow();

        const incompatible = createComputeShader(engine, {
            computeSource: `@compute @workgroup_size(1) fn main() {}`,
            bindings: [
                computeStorageTextureViewBinding("volume", {
                    group: 0,
                    binding: 0,
                    format: "rgba8unorm",
                    access: "write-only",
                    viewDimension: "3d",
                }),
            ],
        });
        expect(() => createComputeBindingSet(incompatible, { volume })).toThrow(/not validated for write-only/);
        disposeComputeStorageTexture(volume);
    });

    it("supports storage-only array resources and rejects invalid dimensions", async () => {
        const { engine } = makeEngine();
        const array = await createComputeStorageTexture(engine, {
            width: 4,
            height: 4,
            depthOrArrayLayers: 3,
            viewDimension: "2d-array",
            format: "r32uint",
            sampled: false,
        });
        expect(array.sampledTexture).toBeNull();
        expect(array.computeTexture).toBeNull();
        disposeComputeStorageTexture(array);

        await expect(
            createComputeStorageTexture(engine, {
                width: 4,
                height: 4,
                depthOrArrayLayers: 2,
                viewDimension: "2d",
                format: "rgba8unorm",
            })
        ).rejects.toThrow(/use 2d-array/);
    });

    it("computes mip counts from texture dimensions rather than 2D-array layer count", async () => {
        const { engine, device } = makeEngine();
        await createComputeStorageTexture(engine, {
            width: 1,
            height: 1,
            depthOrArrayLayers: 256,
            viewDimension: "2d-array",
            format: "rgba8unorm",
            mipMaps: true,
        });
        expect(device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ mipLevelCount: 1 }));
    });

    it.each([1, 4, 128])("rejects 1D mipmaps at width %i before GPU allocation", async (width) => {
        const { engine, device } = makeEngine();
        await expect(
            createComputeStorageTexture(engine, {
                width,
                viewDimension: "1d",
                format: "rgba8unorm",
                mipMaps: true,
            })
        ).rejects.toThrow(/mipMaps.*1d/);
        expect(device.createTexture).not.toHaveBeenCalled();
        expect(device.pushErrorScope).not.toHaveBeenCalled();
        const plain = await createComputeStorageTexture(engine, { width, viewDimension: "1d", format: "rgba8unorm" });
        expect(plain._texture.mipLevelCount).toBe(1);
        expect(plain._texture.usage & GPUTextureUsage.RENDER_ATTACHMENT).toBe(0);
        disposeComputeStorageTexture(plain);
    });

    it.each([
        ["2d", "rgba8unorm", true, true, 3],
        ["2d", "rgba8snorm", true, false, 3],
        ["2d", "rgba16float", true, true, 3],
        ["2d", "rgba16float", false, false, 3],
        ["2d", "r32uint", true, false, 3],
        ["2d", "r32float", true, false, 3],
        ["2d-array", "rgba16float", true, false, 3],
        ["3d", "rgba16float", true, false, 4],
    ] as const)("separates mip allocation from render support for %s/%s (sampled=%s)", async (viewDimension, format, sampled, renderable, levels) => {
        const { engine } = makeEngine();
        const resource = await createComputeStorageTexture(engine, {
            width: 4,
            height: 4,
            depthOrArrayLayers: viewDimension === "2d" ? 1 : 8,
            viewDimension,
            format,
            sampled,
            mipMaps: true,
        });
        expect(resource._texture.mipLevelCount).toBe(levels);
        expect(!!(resource._texture.usage & GPUTextureUsage.RENDER_ATTACHMENT)).toBe(renderable);
        if (renderable) {
            createComputeStorageTextureMipmapsTask("mips", [resource]).dispose();
        } else {
            expect(() => createComputeStorageTextureMipmapsTask("mips", [resource])).toThrow(/sampled 2D filterable-float/);
        }
        disposeComputeStorageTexture(resource);
    });

    it("rejects incompatible sample types and foreign-engine texture resources", async () => {
        const first = makeEngine();
        const second = makeEngine();
        await expect(createComputeTextureResource(first.engine, ordinaryTexture(first.engine), { sampleType: "depth" })).rejects.toThrow(/sample type/);
        await expect(createComputeTextureResource(first.engine, ordinaryTexture(second.engine, "depth32float"))).rejects.toThrow(/foreign device/);
    });

    it.each([
        ["rgba8unorm", "unfilterable-float"],
        ["depth32float", "depth"],
        ["rgba8uint", "uint"],
        ["rgba8sint", "sint"],
    ] as const)("infers multisampled %s resources as %s", async (format, sampleType) => {
        const { engine, layouts } = makeEngine();
        const resource = await createComputeTextureResource(engine, ordinaryTexture(engine, format, 4));

        expect(resource.sampleType).toBe(sampleType);
        expect(resource.multisampled).toBe(true);
        expect(layouts.at(-1)!.entries[0]!.texture).toMatchObject({ sampleType, multisampled: true });
    });

    it.each(["depth", "uint", "sint"] as const)("preserves explicit multisampled %s declarations", (sampleType) => {
        const declaration = computeTextureBinding("image", { group: 0, binding: 0, multisampled: true, sampleType });
        expect(declaration._layout.texture).toMatchObject({ sampleType, multisampled: true });
    });

    it("defaults multisampled float declarations to unfilterable and rejects explicit filterable float", () => {
        const declaration = computeTextureBinding("image", { group: 0, binding: 0, multisampled: true });
        expect(declaration._layout.texture).toMatchObject({ sampleType: "unfilterable-float", multisampled: true });
        expect(() => computeTextureBinding("image", { group: 0, binding: 0, multisampled: true, sampleType: "float" })).toThrow(/unfilterable-float/);
    });

    it("rejects adaptation when the engine device changes during validation", async () => {
        const first = makeEngine();
        let resolveValidation!: (error: GPUError | null) => void;
        (first.device.popErrorScope as ReturnType<typeof vi.fn>).mockReturnValue(
            new Promise<GPUError | null>((resolve) => {
                resolveValidation = resolve;
            })
        );
        const pending = createComputeTextureResource(first.engine, ordinaryTexture(first.engine));

        first.engine._device = makeEngine().device;
        resolveValidation(null);

        await expect(pending).rejects.toThrow(/device changed/);
    });

    it("classifies integer formats and rejects array/3D wrappers from the 2D helper", async () => {
        const { engine } = makeEngine();
        const uintTexture = ordinaryTexture(engine, "rgba8uint");
        expect((await createComputeTextureResource(engine, uintTexture)).sampleType).toBe("uint");
        await expect(createComputeTextureResource(engine, ordinaryTexture(engine, "depth24plus-stencil8"))).rejects.toThrow(/stencil/);
        const depthOnly = ordinaryTexture(engine, "depth24plus-stencil8");
        depthOnly._sampleType = "depth";
        expect((await createComputeTextureResource(engine, depthOnly)).sampleType).toBe("depth");

        const arrayTexture = { ...ordinaryTexture(engine), layers: 2 };
        await expect(createComputeTextureResource(engine, arrayTexture)).rejects.toThrow(/only 2D/);
        const volumeTexture = { ...ordinaryTexture(engine), depth: 2 };
        await expect(createComputeTextureResource(engine, volumeTexture)).rejects.toThrow(/only 2D/);
    });

    it("adapts existing float32 textures as unfilterable by default", async () => {
        const { engine } = makeEngine();
        const pyramid = createDepthPyramid(engine, { width: 4, height: 4 });
        const resource = await createComputeTextureResource(engine, pyramid.texture);
        expect(resource.sampleType).toBe("unfilterable-float");
        pyramid.dispose();
    });

    it("invalidates cached groups when a storage texture is disposed", () => {
        const { engine } = makeEngine();
        const texture = createComputeStorageTexture2D(engine, { width: 4, height: 4, format: "rgba8unorm" });
        const shader = createComputeShader(engine, {
            computeSource: `@compute @workgroup_size(1) fn main() {}`,
            bindings: [computeStorageTextureBinding("output", { group: 0, binding: 0, format: "rgba8unorm" })],
        });
        const bindings = createComputeBindingSet(shader, { output: texture });
        disposeComputeStorageTexture2D(texture);

        expect(() => _ensureComputeBindingGroups(bindings)).toThrow(/invalid storage texture/);
    });

    it("keeps storage textures alive while cloned sampled facades are owned", () => {
        const { engine } = makeEngine();
        const texture = createComputeStorageTexture2D(engine, { width: 4, height: 4, format: "rgba8unorm" });
        const clone = cloneComputeStorageTexture2D(texture, { uScale: 2 });
        acquireTexture(clone);
        const gpu = clone.texture as unknown as { destroy: ReturnType<typeof vi.fn> };
        expect(() => disposeComputeStorageTexture2D(texture)).toThrow(/still owned/);
        expect(gpu.destroy).not.toHaveBeenCalled();
        releaseTexture(clone);
        disposeComputeStorageTexture2D(texture);
        expect(gpu.destroy).toHaveBeenCalledOnce();
    });

    it("force-disposes owned storage textures during engine teardown", () => {
        const { engine, device } = makeEngine();
        Object.assign(engine, {
            _surfaces: [],
            surfaces: [],
            _animFrameId: 0,
            _renderFn: null,
        });
        const texture = createComputeStorageTexture2D(engine, { width: 4, height: 4, format: "rgba8unorm" });
        const clone = cloneComputeStorageTexture2D(texture, {});
        acquireTexture(clone);

        expect(() => disposeEngine(engine)).not.toThrow();
        expect(texture._destroyed).toBe(true);
        expect(device.destroy).toHaveBeenCalledOnce();
    });

    it("validates storage texture dimensions and formats", () => {
        const { engine } = makeEngine();
        expect(() => createComputeStorageTexture2D(engine, { width: 5000, height: 1, format: "rgba8unorm" })).toThrow(/4096/);
    });

    it("creates compute samplers with explicit binding types outside the render cache", () => {
        const { engine, device } = makeEngine();
        const ordinary = createComputeSampler(engine);
        const comparison = createComputeSampler(engine, { compare: "less" });
        const filtering = createComputeSampler(engine, { minFilter: "linear" });

        expect(comparison).not.toBe(ordinary);
        expect(ordinary.type).toBe("non-filtering");
        expect(comparison.type).toBe("comparison");
        expect(filtering.type).toBe("filtering");
        expect(device.createSampler).toHaveBeenCalledTimes(3);

        const shader = createComputeShader(engine, {
            computeSource: `@compute @workgroup_size(1) fn main() {}`,
            bindings: [computeSamplerBinding("sampler", { group: 0, binding: 0 })],
        });
        expect(() => createComputeBindingSet(shader, { sampler: ordinary })).not.toThrow();
    });

    it("classifies compact float32 storage textures using the device feature while keeping nearest sampling", () => {
        const { engine } = makeEngine(["float32-filterable"]);
        const texture = createComputeStorageTexture2D(engine, { width: 4, height: 4, format: "r32float" });
        expect(texture.computeTexture.sampleType).toBe("float");
        expect(texture.computeSampler.type).toBe("non-filtering");
    });

    it.each(["r32float", "rg32float", "rgba32float"] as const)("rejects filtering %s outputs without float32-filterable before allocation", async (format) => {
        const { engine, device } = makeEngine();
        for (const filter of ["minFilter", "magFilter", "mipmapFilter"] as const) {
            await expect(
                createComputeStorageTexture(engine, {
                    width: 4,
                    height: 4,
                    viewDimension: "2d",
                    format,
                    sampler: { [filter]: "linear" },
                })
            ).rejects.toThrow(/unfilterable-float.*filtering sampler/);
        }
        expect(device.createTexture).not.toHaveBeenCalled();
        expect(device.createSampler).not.toHaveBeenCalled();
        expect(device.pushErrorScope).not.toHaveBeenCalled();
    });

    it.each(["r32float", "rg32float", "rgba32float"] as const)("reuses the validated filtering %s view/sampler pair when the feature is enabled", async (format) => {
        const { engine, device, layouts, groups } = makeEngine(["float32-filterable"]);
        const resource = await createComputeStorageTexture(engine, {
            width: 4,
            height: 4,
            viewDimension: "2d",
            format,
            mipMaps: true,
            sampler: { minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" },
        });
        expect(resource.computeTexture!.sampleType).toBe("float");
        expect(resource.computeSampler!.type).toBe("filtering");
        expect(device.createSampler).toHaveBeenCalledOnce();
        const layout = layouts.find((layout) => Array.from(layout.entries).some((entry) => entry.texture))!;
        expect(Array.from(layout.entries)).toMatchObject([
            { binding: 0, texture: { sampleType: "float", viewDimension: "2d" } },
            { binding: 1, sampler: { type: "filtering" } },
        ]);
        const group = groups.find((group) => Object.is(group.layout, layout))!;
        const entries = Array.from(group.entries);
        expect(entries[0]!.resource).toBe(resource.sampledTexture!.view);
        expect(entries[1]!.resource).toBe(resource.computeSampler!._sampler);
        expect(resource.sampledTexture!.sampler).toBe(resource.computeSampler!._sampler);
        const shader = createComputeShader(engine, {
            computeSource: "@compute @workgroup_size(1) fn main() {}",
            bindings: [
                computeTextureBinding("image", { group: 0, binding: 0, sampleType: "float" }),
                computeSamplerBinding("sampler", { group: 0, binding: 1, type: "filtering" }),
            ],
        });
        expect(() => createComputeBindingSet(shader, { image: resource.computeTexture, sampler: resource.computeSampler })).not.toThrow();
    });

    it.each([false, true])("keeps nearest-only compact and advanced metadata consistent (float32-filterable=%s)", async (filterable) => {
        const { engine } = makeEngine(filterable ? ["float32-filterable"] : []);
        for (const format of ["r32float", "rgba32float"] as const) {
            const compact = createComputeStorageTexture2D(engine, { width: 4, height: 4, format });
            const advanced = await createComputeStorageTexture(engine, { width: 4, height: 4, viewDimension: "2d", format });
            for (const resource of [compact, advanced]) {
                expect(resource.computeTexture!.sampleType).toBe(filterable ? "float" : "unfilterable-float");
                expect(resource.computeSampler!.type).toBe("non-filtering");
                const shader = createComputeShader(engine, {
                    computeSource: "@compute @workgroup_size(1) fn main() {}",
                    bindings: [
                        computeTextureBinding("image", { group: 0, binding: 0, sampleType: "unfilterable-float" }),
                        computeSamplerBinding("sampler", { group: 0, binding: 1, type: "non-filtering" }),
                    ],
                });
                expect(() => createComputeBindingSet(shader, { image: resource.computeTexture, sampler: resource.computeSampler })).not.toThrow();
            }
        }
    });

    it.each(["1d", "2d-array", "3d"] as const)("classifies sampled float32 %s views consistently", async (viewDimension) => {
        const { engine } = makeEngine(["float32-filterable"]);
        const resource = await createComputeStorageTexture(engine, {
            width: 4,
            viewDimension,
            format: "r32float",
            sampler: { minFilter: "linear" },
        });
        expect(resource.computeTexture!.sampleType).toBe("float");
        expect(resource.computeTexture!.viewDimension).toBe(viewDimension);
        expect(resource.computeSampler!.type).toBe("filtering");
    });

    it.each(["r32uint", "r32sint"] as const)("rejects filtering integer %s outputs without restricting storage-only resources", async (format) => {
        const { engine, device } = makeEngine(["float32-filterable"]);
        await expect(
            createComputeStorageTexture(engine, {
                width: 4,
                viewDimension: "2d",
                format,
                sampler: { minFilter: "linear" },
            })
        ).rejects.toThrow(/incompatible with a filtering sampler/);
        expect(device.createTexture).not.toHaveBeenCalled();
        const resource = await createComputeStorageTexture(engine, {
            width: 4,
            viewDimension: "2d",
            format,
            sampled: false,
            sampler: { minFilter: "linear" },
        });
        expect(resource.computeTexture).toBeNull();
        expect(resource.computeSampler).toBeNull();
        expect(device.createSampler).not.toHaveBeenCalled();
    });

    it("keeps filterable formats usable without the optional feature and rejects color comparison samplers", async () => {
        const { engine, device } = makeEngine();
        const resource = await createComputeStorageTexture(engine, {
            width: 4,
            viewDimension: "2d",
            format: "rgba16float",
            sampler: { minFilter: "linear" },
        });
        expect(resource.computeTexture!.sampleType).toBe("float");
        expect(resource.computeSampler!.type).toBe("filtering");
        vi.mocked(device.createTexture).mockClear();
        await expect(
            createComputeStorageTexture(engine, {
                width: 4,
                viewDimension: "2d",
                format: "rgba8unorm",
                sampler: { compare: "less" },
            })
        ).rejects.toThrow(/comparison sampler/);
        expect(device.createTexture).not.toHaveBeenCalled();
    });

    it("snapshots the sampler descriptor across validation and returns the same validated GPU objects", async () => {
        const { engine, device, groups } = makeEngine();
        let completeValidation!: (error: GPUError | null) => void;
        vi.mocked(device.popErrorScope).mockReturnValueOnce(
            new Promise<GPUError | null>((resolve) => {
                completeValidation = resolve;
            })
        );
        const sampler: GPUSamplerDescriptor = { minFilter: "nearest" };
        const pending = createComputeStorageTexture(engine, { width: 4, viewDimension: "2d", format: "r32float", sampler });
        sampler.minFilter = "linear";
        completeValidation(null);
        const resource = await pending;
        expect(resource.computeTexture!.sampleType).toBe("unfilterable-float");
        expect(resource.computeSampler!.type).toBe("non-filtering");
        expect(device.createSampler).toHaveBeenCalledOnce();
        expect(device.createSampler).toHaveBeenCalledWith({ minFilter: "nearest" });
        expect(Array.from(groups.at(-1)!.entries)[1]!.resource).toBe(resource.computeSampler!._sampler);
    });

    it("cleans the local texture when creation of its sampler fails", async () => {
        const { engine, device, textures } = makeEngine();
        vi.mocked(device.createSampler).mockImplementationOnce(() => {
            throw new Error("sampler failed");
        });
        await expect(
            createComputeStorageTexture(engine, {
                width: 4,
                viewDimension: "2d",
                format: "rgba8unorm",
            })
        ).rejects.toThrow(/sampler failed/);
        expect(textures[0]!.destroy).toHaveBeenCalledOnce();
        expect(device.popErrorScope).toHaveBeenCalledOnce();
        expect(engine._managedResourceDisposers).toBeUndefined();
    });

    it("invalidates cached texture bindings when the last texture reference is released", async () => {
        const { engine } = makeEngine();
        const texture = ordinaryTexture(engine);
        acquireTexture(texture);
        const resource = await createComputeTextureResource(engine, texture);
        const shader = createComputeShader(engine, {
            computeSource: `@compute @workgroup_size(1) fn main() {}`,
            bindings: [computeTextureBinding("source", { group: 0, binding: 0 })],
        });
        const bindings = createComputeBindingSet(shader, { source: resource });

        releaseTexture(texture);

        expect(() => _ensureComputeBindingGroups(bindings)).toThrow(/invalid texture/);
    });

    it("rebuilds cached groups when a stable texture facade replaces its allocation", async () => {
        const { engine, groups } = makeEngine();
        const texture = ordinaryTexture(engine);
        const resource = await createComputeTextureResource(engine, texture);
        const shader = createComputeShader(engine, {
            computeSource: `@compute @workgroup_size(1) fn main() {}`,
            bindings: [computeTextureBinding("source", { group: 0, binding: 0 })],
        });
        const bindings = createComputeBindingSet(shader, { source: resource });
        const initialGroup = bindings._groups![0]!;
        const replacement = ordinaryTexture(engine);
        Object.assign(texture, { texture: replacement.texture, view: replacement.view });

        _ensureComputeBindingGroups(bindings);

        const rebuiltGroup = groups.at(-1)!;
        expect(bindings._groups).toEqual([rebuiltGroup]);
        expect(rebuiltGroup).not.toBe(initialGroup);
        expect(Array.from(rebuiltGroup.entries)[0]!.resource).toBe(replacement.view);
    });

    it("freezes every resource-specific binding layout descriptor", () => {
        const declarations = [
            computeTextureBinding("texture", { group: 0, binding: 0 }),
            computeSamplerBinding("sampler", { group: 0, binding: 1 }),
            computeStorageTextureBinding("storage", { group: 0, binding: 2, format: "rgba8unorm" }),
        ];

        for (const declaration of declarations) {
            const layout = declaration._layout;
            expect(Object.isFrozen(layout.texture ?? layout.sampler ?? layout.storageTexture)).toBe(true);
        }
    });

    it("rejects unsupported storage formats and texture binding counts over device limits", () => {
        const { engine } = makeEngine();
        expect(() =>
            createComputeStorageTexture2D(engine, {
                width: 4,
                height: 4,
                format: "depth32float" as unknown as "rgba8unorm",
            })
        ).toThrow(/not supported/);
        expect(() =>
            computeStorageTextureBinding("bad", {
                group: 0,
                binding: 0,
                format: "bc1-rgba-unorm" as unknown as "rgba8unorm",
            })
        ).toThrow(/not supported/);

        Object.assign(engine._device.limits, {
            maxSampledTexturesPerShaderStage: 1,
            maxSamplersPerShaderStage: 1,
            maxStorageTexturesPerShaderStage: 1,
        });
        expect(() =>
            createComputeShader(engine, {
                computeSource: `@compute @workgroup_size(1) fn main() {}`,
                bindings: [computeTextureBinding("a", { group: 0, binding: 0 }), computeTextureBinding("b", { group: 0, binding: 1 })],
            })
        ).toThrow(/sampled textures/);
        expect(() =>
            createComputeShader(engine, {
                computeSource: `@compute @workgroup_size(1) fn main() {}`,
                bindings: [computeSamplerBinding("a", { group: 0, binding: 0 }), computeSamplerBinding("b", { group: 0, binding: 1 })],
            })
        ).toThrow(/samplers/);
        expect(() =>
            createComputeShader(engine, {
                computeSource: `@compute @workgroup_size(1) fn main() {}`,
                bindings: [
                    computeStorageTextureBinding("a", { group: 0, binding: 0, format: "rgba8unorm" }),
                    computeStorageTextureBinding("b", { group: 0, binding: 1, format: "rgba8unorm" }),
                ],
            })
        ).toThrow(/storage textures/);
    });
});
