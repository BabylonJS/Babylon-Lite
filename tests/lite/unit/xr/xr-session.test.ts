import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine";
import { createSceneContext } from "../../../../packages/babylon-lite/src/scene/scene";
import type { RenderTarget } from "../../../../packages/babylon-lite/src/engine/render-target";
import { enterXr, exitXr } from "../../../../packages/babylon-lite/src/xr/xr-session";

const gpuGlobals = globalThis as Record<string, unknown>;
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 };
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 };
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4, COPY_SRC: 0x1, COPY_DST: 0x2 };

let beginPassCount = 0;
let submitCount = 0;

function makeMockEngine(): EngineContext {
    const pass = {
        setViewport: () => undefined,
        setScissorRect: () => undefined,
        setBindGroup: () => undefined,
        executeBundles: () => undefined,
        setPipeline: () => undefined,
        draw: () => undefined,
        end: () => undefined,
    } as unknown as GPURenderPassEncoder;
    const makeEncoder = (): GPUCommandEncoder =>
        ({
            beginRenderPass: () => {
                beginPassCount++;
                return pass;
            },
            copyTextureToTexture: () => undefined,
            finish: () => ({}) as GPUCommandBuffer,
        }) as unknown as GPUCommandEncoder;
    const device = {
        createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => d as unknown as GPUBindGroupLayout,
        createBuffer: (d: GPUBufferDescriptor) => ({ descriptor: d, destroy: () => undefined }) as unknown as GPUBuffer,
        createBindGroup: (d: GPUBindGroupDescriptor) => d as unknown as GPUBindGroup,
        createSampler: (d: GPUSamplerDescriptor) => d as unknown as GPUSampler,
        createShaderModule: (d: GPUShaderModuleDescriptor) => d as unknown as GPUShaderModule,
        createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => d as unknown as GPUPipelineLayout,
        createRenderPipeline: (d: GPURenderPipelineDescriptor) => d as unknown as GPURenderPipeline,
        createTexture: (d: GPUTextureDescriptor) =>
            ({
                descriptor: d,
                format: d.format,
                createView: () => ({}) as GPUTextureView,
                destroy: () => undefined,
            }) as unknown as GPUTexture,
        createRenderBundleEncoder: () =>
            ({
                setBindGroup: () => undefined,
                setPipeline: () => undefined,
                finish: () => ({}) as GPURenderBundle,
            }) as unknown as GPURenderBundleEncoder,
        createCommandEncoder: () => makeEncoder(),
        queue: {
            writeBuffer: () => undefined,
            submit: () => {
                submitCount++;
            },
        },
    } as unknown as GPUDevice;

    const eng = {
        canvas: { width: 800, height: 600 } as HTMLCanvasElement,
        msaaSamples: 1,
        drawCallCount: 0,
        maxDevicePixelRatio: Infinity,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        _device: device,
        _context: { configure: () => undefined } as unknown as GPUCanvasContext,
        format: "bgra8unorm",
        _alphaMode: "opaque",
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: makeEncoder(),
        scRT: {
            _colorTexture: {},
            _colorView: {},
            _depthTexture: null,
            _depthView: null,
            _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 800, height: 600 } },
            _width: 800,
            _height: 600,
            _eager: true,
        } as unknown as RenderTarget,
        _currentDelta: 0,
        _cbs: [],
    } as unknown as EngineContext;
    const surfaces = [eng];
    Object.assign(eng, { engine: eng, surfaces, _surfaces: surfaces });
    return eng;
}

// ─── Mock WebXR / WebGPU-binding globals ─────────────────────────────

interface RafEntry {
    id: number;
    cb: XRFrameRequestCallback;
}

class FakeXrSession {
    listeners: { type: string; fn: EventListener }[] = [];
    inputSources: unknown[] = [];
    rafs: RafEntry[] = [];
    nextId = 1;
    renderState: unknown = null;
    ended = false;

    requestAnimationFrame(cb: XRFrameRequestCallback): number {
        const id = this.nextId++;
        this.rafs.push({ id, cb });
        return id;
    }
    cancelAnimationFrame(id: number): void {
        this.rafs = this.rafs.filter((r) => r.id !== id);
    }
    async updateRenderState(state: unknown): Promise<void> {
        this.renderState = state;
    }
    async requestReferenceSpace(): Promise<XRReferenceSpace> {
        return {} as XRReferenceSpace;
    }
    async end(): Promise<void> {
        this.ended = true;
        for (const l of this.listeners.filter((l) => l.type === "end")) {
            l.fn({} as Event);
        }
    }
    addEventListener(type: string, fn: EventListener): void {
        this.listeners.push({ type, fn });
    }
    removeEventListener(type: string, fn: EventListener): void {
        this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn));
    }

    /** Drive the most recently scheduled frame callback. */
    drive(time: number, frame: XRFrame): void {
        const next = this.rafs.shift();
        next?.cb(time, frame);
    }
}

function makeProjection(): Float32Array {
    const p = new Float32Array(16);
    p[0] = p[5] = p[10] = p[15] = 1;
    return p;
}

function makeViewerPose(): XRViewerPose {
    const view = (eye: XREye): XRView =>
        ({
            eye,
            transform: {
                matrix: (() => {
                    const m = new Float32Array(16);
                    m[0] = m[5] = m[10] = m[15] = 1;
                    return m;
                })(),
            } as XRRigidTransform,
            projectionMatrix: makeProjection(),
        }) as unknown as XRView;
    return { views: [view("left"), view("right")] } as unknown as XRViewerPose;
}

function makeFrame(pose: XRViewerPose | null): XRFrame {
    return {
        getViewerPose: () => pose,
        getPose: () => null,
    } as unknown as XRFrame;
}

let currentSession: FakeXrSession;

function installXrGlobals(opts?: { sessionSupported?: boolean }): void {
    const g = globalThis as Record<string, unknown>;
    g.navigator = {
        xr: {
            requestSession: async () => {
                currentSession = new FakeXrSession();
                return currentSession as unknown as XRSession;
            },
            isSessionSupported: async () => opts?.sessionSupported ?? true,
        },
    } as unknown as Navigator;

    class FakeBinding {
        constructor(_session: XRSession, _device: GPUDevice) {}
        getPreferredColorFormat(): GPUTextureFormat {
            return "rgba8unorm";
        }
        createProjectionLayer(): XRProjectionLayer {
            return { textureWidth: 512, textureHeight: 512 } as unknown as XRProjectionLayer;
        }
        getViewSubImage(): unknown {
            return {
                colorTexture: { createView: () => ({}) as GPUTextureView } as unknown as GPUTexture,
                depthStencilTexture: { createView: () => ({}) as GPUTextureView } as unknown as GPUTexture,
                getViewDescriptor: () => ({}) as GPUTextureViewDescriptor,
                viewport: { x: 0, y: 0, width: 512, height: 512 },
            };
        }
    }
    g.XRGPUBinding = FakeBinding;
}

function clearXrGlobals(): void {
    const g = globalThis as Record<string, unknown>;
    delete g.XRGPUBinding;
    delete g.navigator;
}

describe("xr-session lifecycle", () => {
    const g = globalThis as Record<string, unknown>;
    const prevNavigator = g.navigator;
    const prevBinding = g.XRGPUBinding;
    const prevRaf = g.requestAnimationFrame;
    const prevCancel = g.cancelAnimationFrame;

    beforeEach(() => {
        beginPassCount = 0;
        submitCount = 0;
        // Stub canvas-loop globals used by start/stopEngine (never actually fires).
        g.requestAnimationFrame = () => 1;
        g.cancelAnimationFrame = () => undefined;
    });

    afterEach(() => {
        clearXrGlobals();
        if (prevNavigator === undefined) delete g.navigator;
        else g.navigator = prevNavigator;
        if (prevBinding === undefined) delete g.XRGPUBinding;
        else g.XRGPUBinding = prevBinding;
        if (prevRaf === undefined) delete g.requestAnimationFrame;
        else g.requestAnimationFrame = prevRaf;
        if (prevCancel === undefined) delete g.cancelAnimationFrame;
        else g.cancelAnimationFrame = prevCancel;
    });

    it("throws when WebXR is unavailable", async () => {
        clearXrGlobals();
        const scene = createSceneContext(makeMockEngine());
        await expect(enterXr(scene)).rejects.toThrow(/WebXR is not available/);
    });

    it("throws when the WebGPU binding is unavailable", async () => {
        g.navigator = { xr: { requestSession: async () => ({}) } } as unknown as Navigator;
        const scene = createSceneContext(makeMockEngine());
        await expect(enterXr(scene)).rejects.toThrow(/WebGPU XR is not supported/);
    });

    it("enters, renders both eyes on a frame, and exits", async () => {
        installXrGlobals();
        const scene = createSceneContext(makeMockEngine());
        const ctx = await enterXr(scene, { input: false });

        expect(ctx.mode).toBe("immersive-vr");
        expect(currentSession.renderState).toBeTruthy();
        expect(currentSession.rafs.length).toBe(1);

        currentSession.drive(16, makeFrame(makeViewerPose()));

        // Two eyes → two cameras, two render passes, one submitted command buffer.
        expect(ctx.cameras.length).toBe(2);
        expect(ctx.cameras[0]!.eye).toBe("left");
        expect(ctx.cameras[1]!.eye).toBe("right");
        expect(beginPassCount).toBeGreaterThanOrEqual(2);
        expect(submitCount).toBe(1);

        await exitXr(ctx);
        expect(currentSession.ended).toBe(true);
        // After end the loop is torn down.
        expect(ctx.cameras.length).toBe(0);
    });

    it("skips rendering when no viewer pose is available but keeps the loop alive", async () => {
        installXrGlobals();
        const scene = createSceneContext(makeMockEngine());
        const ctx = await enterXr(scene, { input: false });

        currentSession.drive(16, makeFrame(null));
        expect(submitCount).toBe(0);
        // A fresh frame was rescheduled.
        expect(currentSession.rafs.length).toBe(1);
        await exitXr(ctx);
    });

    it("forces clearColor alpha to 0 in AR and restores it on exit", async () => {
        installXrGlobals();
        const scene = createSceneContext(makeMockEngine());
        scene.clearColor = { r: 0.1, g: 0.2, b: 0.3, a: 1 };
        const ctx = await enterXr(scene, { mode: "immersive-ar", input: false });

        expect(scene.clearColor.a).toBe(0);
        await exitXr(ctx);
        expect(scene.clearColor.a).toBe(1);
        expect(scene.clearColor.r).toBeCloseTo(0.1, 6);
    });

    it("does not touch clearColor in VR mode", async () => {
        installXrGlobals();
        const scene = createSceneContext(makeMockEngine());
        scene.clearColor = { r: 0.1, g: 0.2, b: 0.3, a: 1 };
        const ctx = await enterXr(scene, { mode: "immersive-vr", input: false });
        expect(scene.clearColor.a).toBe(1);
        await exitXr(ctx);
    });

    it("creates an input manager by default and disposes it on exit", async () => {
        installXrGlobals();
        const scene = createSceneContext(makeMockEngine());
        const ctx = await enterXr(scene);
        expect(ctx.input).not.toBeNull();
        const disposeSpy = vi.spyOn(currentSession, "removeEventListener");
        await exitXr(ctx);
        expect(disposeSpy).toHaveBeenCalled();
    });

    it("invokes the onFrame and onEnd callbacks", async () => {
        installXrGlobals();
        const onFrame = vi.fn();
        const onEnd = vi.fn();
        const scene = createSceneContext(makeMockEngine());
        const ctx = await enterXr(scene, { input: false, onFrame, onEnd });
        currentSession.drive(16, makeFrame(makeViewerPose()));
        expect(onFrame).toHaveBeenCalledOnce();
        await exitXr(ctx);
        expect(onEnd).toHaveBeenCalledOnce();
    });
});
