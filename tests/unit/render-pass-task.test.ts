import { describe, it, expect } from "vitest";

import type { Camera } from "../../packages/babylon-lite/src/camera/camera";
import type { EngineContextInternal } from "../../packages/babylon-lite/src/engine/engine";
import type { Mat4 } from "../../packages/babylon-lite/src/math/types";
import type { DrawBinding, DrawUpdateContext, Renderable } from "../../packages/babylon-lite/src/render/renderable";
import { createSceneContext, registerScene } from "../../packages/babylon-lite/src/scene/scene";
import type { SceneContextInternal } from "../../packages/babylon-lite/src/scene/scene-core";
import { enableSceneTransmission } from "../../packages/babylon-lite/src/frame-graph/transmission";

const gpuGlobals = globalThis as typeof globalThis & {
    GPUBufferUsage?: { UNIFORM: number; COPY_DST: number };
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
    GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number; COPY_DST: number };
};

gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 };
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 };
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4, COPY_SRC: 0x1, COPY_DST: 0x2 };

function makeIdentityMatrix(z = 0): Mat4 {
    const matrix = new Float32Array(16);
    matrix[0] = 1;
    matrix[5] = 1;
    matrix[10] = 1;
    matrix[12] = 0;
    matrix[13] = 0;
    matrix[14] = z;
    matrix[15] = 1;
    return matrix as Mat4;
}

function makeCamera(): Camera {
    return {
        fov: Math.PI / 4,
        nearPlane: 0.1,
        farPlane: 100,
        children: [],
        worldMatrix: makeIdentityMatrix(),
        worldMatrixVersion: 1,
    };
}

function makeMockEngine(options?: {
    msaaSamples?: 1 | 4;
    onBeginPass?: (descriptor: GPURenderPassDescriptor) => void;
    onCopy?: () => void;
    bindGroupLayouts?: GPUBindGroupLayoutDescriptor[];
    samplers?: GPUSamplerDescriptor[];
    textures?: GPUTextureDescriptor[];
}): EngineContextInternal {
    let currentPipeline: GPURenderPipeline | null = null;
    const pass = {
        setViewport: () => undefined,
        setScissorRect: () => undefined,
        setBindGroup: () => undefined,
        executeBundles: () => undefined,
        setPipeline: (pipeline: GPURenderPipeline) => {
            currentPipeline = pipeline;
        },
        draw: () => {
            if ((currentPipeline as { label?: string } | null)?.label === "transmission-copy") {
                options?.onCopy?.();
            }
        },
        end: () => undefined,
    } as unknown as GPURenderPassEncoder;
    const device = {
        createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => {
            options?.bindGroupLayouts?.push(descriptor);
            return descriptor as unknown as GPUBindGroupLayout;
        },
        createBuffer: (descriptor: GPUBufferDescriptor) => ({ descriptor, destroy: () => undefined }) as unknown as GPUBuffer,
        createBindGroup: (descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup,
        createSampler: (descriptor: GPUSamplerDescriptor) => {
            options?.samplers?.push(descriptor);
            return descriptor as unknown as GPUSampler;
        },
        createShaderModule: (descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule,
        createPipelineLayout: (descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout,
        createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline,
        createTexture: (descriptor: GPUTextureDescriptor) => {
            options?.textures?.push(descriptor);
            return {
                descriptor,
                format: descriptor.format,
                mipLevelCount: descriptor.mipLevelCount ?? 1,
                sampleCount: descriptor.sampleCount ?? 1,
                createView: () => ({}) as GPUTextureView,
                destroy: () => undefined,
            } as unknown as GPUTexture;
        },
        createRenderBundleEncoder: () =>
            ({
                setBindGroup: () => undefined,
                setPipeline: () => undefined,
                finish: () => ({}) as GPURenderBundle,
            }) as unknown as GPURenderBundleEncoder,
        queue: {
            writeBuffer: () => undefined,
        },
    } as unknown as GPUDevice;

    return {
        canvas: { width: 800, height: 600 } as HTMLCanvasElement,
        msaaSamples: options?.msaaSamples ?? 4,
        drawCallCount: 0,
        device,
        context: { configure: () => undefined } as unknown as GPUCanvasContext,
        format: "bgra8unorm",
        alphaMode: "opaque",
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: {
            beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
                options?.onBeginPass?.(descriptor);
                return pass;
            },
            copyTextureToTexture: () => options?.onCopy?.(),
        } as unknown as GPUCommandEncoder,
        _swapchainView: {} as GPUTextureView,
        _currentDelta: 0,
        _cbs: [],
    };
}

function makeTransparentRenderable(id: string, initialCenter: [number, number, number], updatedCenter: [number, number, number], drawOrder: string[]): Renderable {
    const renderable: Renderable = {
        order: 200,
        isTransparent: true,
        _worldCenter: initialCenter,
        bind(): DrawBinding {
            return {
                renderable,
                pipeline: { id } as unknown as GPURenderPipeline,
                update(_context: DrawUpdateContext): void {
                    renderable._worldCenter = updatedCenter;
                },
                draw(): number {
                    drawOrder.push(id);
                    return 1;
                },
            };
        },
    };
    return renderable;
}

function makeDrawOrderRenderable(id: string, flags: Partial<Pick<Renderable, "order" | "isTransparent" | "_transmissive" | "_direct">>, drawOrder: string[]): Renderable {
    const renderable: Renderable = {
        order: flags.order ?? 100,
        isTransparent: flags.isTransparent ?? false,
        _transmissive: flags._transmissive ?? false,
        _direct: flags._direct ?? false,
        bind(): DrawBinding {
            return {
                renderable,
                pipeline: { id } as unknown as GPURenderPipeline,
                draw(): number {
                    drawOrder.push(id);
                    return 1;
                },
            };
        },
    };
    return renderable;
}

describe("RenderPassTask transparent sorting", () => {
    it("uses world centers refreshed by binding updates before sorting transparent draws", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        scene.camera = makeCamera();
        const drawOrder: string[] = [];

        scene._renderables.push(
            makeTransparentRenderable("far-after-update", [0, 0, 1], [0, 0, 10], drawOrder),
            makeTransparentRenderable("near-after-update", [0, 0, 2], [0, 0, 2], drawOrder)
        );

        await registerScene(engine, scene);
        scene._record();

        expect(drawOrder).toEqual(["far-after-update", "near-after-update"]);
    });

    it("sorts transparent draws by camera-space depth instead of radial distance", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        scene.camera = makeCamera();
        const drawOrder: string[] = [];

        scene._renderables.push(
            makeTransparentRenderable("far-in-view", [0, 0, 0], [0, 0, 10], drawOrder),
            makeTransparentRenderable("near-but-wide", [0, 0, 0], [100, 0, 2], drawOrder)
        );

        await registerScene(engine, scene);
        scene._record();

        expect(drawOrder).toEqual(["far-in-view", "near-but-wide"]);
    });

    it("direct-draws dynamic depth-write renderables without marking them transmissive", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        scene.camera = makeCamera();
        const drawOrder: string[] = [];

        scene._renderables.push(
            makeDrawOrderRenderable("opaque", { order: 100 }, drawOrder),
            makeDrawOrderRenderable("dynamic-depth-write", { order: 110, _direct: true }, drawOrder),
            makeDrawOrderRenderable("transmissive", { order: 140, _transmissive: true, _direct: true }, drawOrder),
            makeDrawOrderRenderable("transparent", { order: 200, isTransparent: true }, drawOrder)
        );

        await registerScene(engine, scene);
        scene._record();

        expect(drawOrder).toEqual(["opaque", "dynamic-depth-write", "transmissive", "transparent"]);
    });

    it("updates per-task transmission snapshots according to copy count", async () => {
        let defaultCopies = 0;
        const defaultEngine = makeMockEngine({ msaaSamples: 1, onCopy: () => defaultCopies++ });
        const defaultScene = createSceneContext(defaultEngine) as SceneContextInternal;
        defaultScene.camera = makeCamera();
        const defaultOrder: string[] = [];
        defaultScene._renderables.push(
            makeDrawOrderRenderable("opaque", { order: 100 }, defaultOrder),
            makeDrawOrderRenderable("glass-a", { order: 150, _transmissive: true }, defaultOrder),
            makeDrawOrderRenderable("glass-b", { order: 150, _transmissive: true }, defaultOrder)
        );
        enableSceneTransmission(defaultScene, defaultEngine);
        await registerScene(defaultEngine, defaultScene);
        defaultScene._record();
        expect(defaultCopies).toBe(1);

        let everyCopies = 0;
        const everyEngine = makeMockEngine({ msaaSamples: 1, onCopy: () => everyCopies++ });
        const everyScene = createSceneContext(everyEngine) as SceneContextInternal;
        everyScene.camera = makeCamera();
        const everyOrder: string[] = [];
        (everyScene._frameGraph._tasks[0]! as { _config: { transmission?: { copyCount: number } } })._config.transmission = { copyCount: 0 };
        everyScene._renderables.push(
            makeDrawOrderRenderable("opaque", { order: 100 }, everyOrder),
            makeDrawOrderRenderable("glass-a", { order: 150, _transmissive: true }, everyOrder),
            makeDrawOrderRenderable("glass-b", { order: 150, _transmissive: true }, everyOrder)
        );
        enableSceneTransmission(everyScene, everyEngine);
        await registerScene(everyEngine, everyScene);
        everyScene._record();
        expect(everyCopies).toBe(2);
    });

    it("uses a repeat anisotropic sampler for the transmission refraction texture", async () => {
        const samplers: GPUSamplerDescriptor[] = [];
        const engine = makeMockEngine({ samplers });
        const scene = createSceneContext(engine) as SceneContextInternal;
        scene.camera = makeCamera();
        scene._renderables.push(makeDrawOrderRenderable("transmissive", { isTransparent: true, _transmissive: true }, []));

        enableSceneTransmission(scene, engine);
        await registerScene(engine, scene);

        expect(samplers).toContainEqual({
            magFilter: "linear",
            minFilter: "linear",
            mipmapFilter: "linear",
            addressModeU: "repeat",
            addressModeV: "repeat",
            addressModeW: "repeat",
            maxAnisotropy: 4,
        });
    });

    it("allocates only refraction mips reachable by the shader LOD bias", async () => {
        const textures: GPUTextureDescriptor[] = [];
        const engine = makeMockEngine({ textures });
        const scene = createSceneContext(engine) as SceneContextInternal;
        scene.camera = makeCamera();
        scene._renderables.push(makeDrawOrderRenderable("glass", { _transmissive: true }, []));

        enableSceneTransmission(scene, engine);
        await registerScene(engine, scene);

        const refractionTexture = textures.find(
            (descriptor) => descriptor.format === "rgba16float" && (descriptor.size as GPUExtent3DDict).width === 1024 && (descriptor.usage & GPUTextureUsage.COPY_DST) !== 0
        );
        expect(refractionTexture?.mipLevelCount).toBe(7);
    });

    it("allocates only mip 0 for transmission when mipmap generation is disabled", async () => {
        const textures: GPUTextureDescriptor[] = [];
        const engine = makeMockEngine({ textures });
        const scene = createSceneContext(engine) as SceneContextInternal;
        scene.camera = makeCamera();
        (scene._frameGraph._tasks[0]! as { _config: { transmission?: { generateMipmaps: false } } })._config.transmission = { generateMipmaps: false };
        scene._renderables.push(makeDrawOrderRenderable("glass", { _transmissive: true }, []));

        enableSceneTransmission(scene, engine);
        await registerScene(engine, scene);

        const refractionTexture = textures.find(
            (descriptor) => descriptor.format === "rgba16float" && (descriptor.size as GPUExtent3DDict).width === 1024 && (descriptor.usage & GPUTextureUsage.COPY_DST) !== 0
        );
        expect(refractionTexture?.mipLevelCount).toBe(1);
    });

    it("samples the MSAA color texture directly for transmission copies and image processing", async () => {
        const textures: GPUTextureDescriptor[] = [];
        const bindGroupLayouts: GPUBindGroupLayoutDescriptor[] = [];
        const mainPassResolveTargets: boolean[] = [];
        const engine = makeMockEngine({
            msaaSamples: 4,
            bindGroupLayouts,
            textures,
            onBeginPass: (descriptor) => {
                if (descriptor.depthStencilAttachment) {
                    mainPassResolveTargets.push(!!(descriptor.colorAttachments[0] as GPURenderPassColorAttachment).resolveTarget);
                }
            },
        });
        const scene = createSceneContext(engine) as SceneContextInternal;
        scene.camera = makeCamera();
        scene._renderables.push(makeDrawOrderRenderable("opaque", { order: 100 }, []), makeDrawOrderRenderable("glass", { order: 150, _transmissive: true }, []));

        enableSceneTransmission(scene, engine);
        await registerScene(engine, scene);
        scene._record();

        expect(textures.some((descriptor) => String(descriptor.label).includes("transmission-snapshot"))).toBe(false);
        expect(textures.some((descriptor) => String(descriptor.label).includes("transmission-scene"))).toBe(false);
        expect(mainPassResolveTargets).toEqual([false, false]);
        expect(bindGroupLayouts).toContainEqual({
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", multisampled: true } }],
        });
        expect(bindGroupLayouts).toContainEqual({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", multisampled: true } },
            ],
        });
    });

    it("renders remaining transmissive draws in one pass after the transmission copy cap", async () => {
        let passCount = 0;
        const engine = makeMockEngine({
            msaaSamples: 1,
            onBeginPass: (descriptor) => {
                if (descriptor.depthStencilAttachment) {
                    passCount++;
                }
            },
        });
        const scene = createSceneContext(engine) as SceneContextInternal;
        scene.camera = makeCamera();
        const drawOrder: string[] = [];
        scene._renderables.push(
            makeDrawOrderRenderable("opaque", { order: 100 }, drawOrder),
            makeDrawOrderRenderable("glass-a", { order: 150, _transmissive: true }, drawOrder),
            makeDrawOrderRenderable("glass-b", { order: 150, _transmissive: true }, drawOrder),
            makeDrawOrderRenderable("glass-c", { order: 150, _transmissive: true }, drawOrder)
        );

        enableSceneTransmission(scene, engine);
        await registerScene(engine, scene);
        scene._record();

        expect(drawOrder).toEqual(["opaque", "glass-a", "glass-b", "glass-c"]);
        expect(passCount).toBe(2);
    });
});
