import { describe, it, expect } from "vitest";

import type { Camera } from "../../packages/babylon-lite/src/camera/camera";
import type { EngineContextInternal } from "../../packages/babylon-lite/src/engine/engine";
import { selectOpaqueSceneRefractionRenderables } from "../../packages/babylon-lite/src/material/pbr/pbr-refraction-setup";
import type { Mat4 } from "../../packages/babylon-lite/src/math/types";
import type { DrawBinding, DrawUpdateContext, Renderable } from "../../packages/babylon-lite/src/render/renderable";
import { createSceneContext, registerScene } from "../../packages/babylon-lite/src/scene/scene";
import type { SceneContextInternal } from "../../packages/babylon-lite/src/scene/scene-core";

const gpuGlobals = globalThis as typeof globalThis & {
    GPUBufferUsage?: { UNIFORM: number; COPY_DST: number };
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
    GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
};

gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 };
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 };
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4 };

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

function makeMockEngine(): EngineContextInternal {
    const pass = {
        setViewport: () => undefined,
        setScissorRect: () => undefined,
        setBindGroup: () => undefined,
        executeBundles: () => undefined,
        setPipeline: () => undefined,
        end: () => undefined,
    } as unknown as GPURenderPassEncoder;
    const device = {
        createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout,
        createBuffer: (descriptor: GPUBufferDescriptor) => ({ descriptor, destroy: () => undefined }) as unknown as GPUBuffer,
        createBindGroup: (descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup,
        createTexture: (descriptor: GPUTextureDescriptor) =>
            ({
                descriptor,
                createView: () => ({}) as GPUTextureView,
                destroy: () => undefined,
            }) as unknown as GPUTexture,
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
        msaaSamples: 4,
        drawCallCount: 0,
        device,
        context: {} as GPUCanvasContext,
        format: "bgra8unorm",
        alphaMode: "opaque",
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: {
            beginRenderPass: () => pass,
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

function makeDrawOrderRenderable(id: string, flags: Partial<Pick<Renderable, "order" | "isTransparent" | "isTransmissive" | "_direct">>, drawOrder: string[]): Renderable {
    const renderable: Renderable = {
        order: flags.order ?? 100,
        isTransparent: flags.isTransparent ?? false,
        isTransmissive: flags.isTransmissive ?? false,
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

    it("direct-draws dynamic depth-write renderables without marking them transmissive", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        scene.camera = makeCamera();
        const drawOrder: string[] = [];

        scene._renderables.push(
            makeDrawOrderRenderable("opaque", { order: 100 }, drawOrder),
            makeDrawOrderRenderable("dynamic-depth-write", { order: 110, _direct: true }, drawOrder),
            makeDrawOrderRenderable("transmissive", { order: 140, isTransmissive: true, _direct: true }, drawOrder),
            makeDrawOrderRenderable("transparent", { order: 200, isTransparent: true }, drawOrder)
        );

        await registerScene(engine, scene);
        scene._record();

        expect(drawOrder).toEqual(["opaque", "dynamic-depth-write", "transmissive", "transparent"]);
    });

    it("keeps dynamic depth-write renderables in the opaque refraction RTT and excludes true transmissive surfaces", () => {
        const drawOrder: string[] = [];
        const opaque = makeDrawOrderRenderable("opaque", { order: 100 }, drawOrder);
        const dynamicDepthWrite = makeDrawOrderRenderable("dynamic-depth-write", { order: 110, _direct: true }, drawOrder);
        const transmissive = makeDrawOrderRenderable("transmissive", { order: 140, isTransmissive: true }, drawOrder);

        expect(selectOpaqueSceneRefractionRenderables([opaque, dynamicDepthWrite, transmissive])).toEqual([opaque, dynamicDepthWrite]);
    });
});
