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
            onSubmittedWorkDone: () => Promise.resolve(),
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
    requestedRefSpaces: XRReferenceSpaceType[] = [];
    /** Reference-space types this fake headset will grant; others reject (spec behaviour). */
    grantedRefSpaces: XRReferenceSpaceType[] = ["viewer", "local", "local-floor", "bounded-floor", "unbounded"];
    updateRenderStateError: Error | null = null;

    requestAnimationFrame(cb: XRFrameRequestCallback): number {
        const id = this.nextId++;
        this.rafs.push({ id, cb });
        return id;
    }
    cancelAnimationFrame(id: number): void {
        this.rafs = this.rafs.filter((r) => r.id !== id);
    }
    async updateRenderState(state: unknown): Promise<void> {
        if (this.updateRenderStateError) {
            throw this.updateRenderStateError;
        }
        this.renderState = state;
    }
    async requestReferenceSpace(type: XRReferenceSpaceType): Promise<XRReferenceSpace> {
        this.requestedRefSpaces.push(type);
        if (!this.grantedRefSpaces.includes(type)) {
            throw new DOMException(`Reference space ${type} not supported`, "NotSupportedError");
        }
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
let lastSessionInit: XRSessionInit | undefined;

function installXrGlobals(opts?: { sessionSupported?: boolean; grantedRefSpaces?: XRReferenceSpaceType[]; projectionLayerError?: Error; updateRenderStateError?: Error }): void {
    const g = globalThis as Record<string, unknown>;
    g.navigator = {
        xr: {
            requestSession: async (_mode: XRSessionMode, init?: XRSessionInit) => {
                lastSessionInit = init;
                currentSession = new FakeXrSession();
                if (opts?.grantedRefSpaces) {
                    currentSession.grantedRefSpaces = opts.grantedRefSpaces;
                }
                currentSession.updateRenderStateError = opts?.updateRenderStateError ?? null;
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
            if (opts?.projectionLayerError) {
                throw opts.projectionLayerError;
            }
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

    it("wraps an XRGPUBinding InvalidStateError and ends the session", async () => {
        installXrGlobals();
        // Simulate a device whose adapter was not xrCompatible: the binding ctor throws.
        (g as Record<string, unknown>).XRGPUBinding = class {
            constructor() {
                throw new DOMException("WebGPU device must be created by a compatible adapter", "InvalidStateError");
            }
        };
        const scene = createSceneContext(makeMockEngine());
        await expect(enterXr(scene)).rejects.toThrow(/enableXrCompatibleAdapter\(\)/);
        expect(currentSession.ended).toBe(true);
    });

    it("ends the session when projection-layer creation fails", async () => {
        installXrGlobals({ projectionLayerError: new Error("layer boom") });
        const scene = createSceneContext(makeMockEngine());

        await expect(enterXr(scene, { input: false })).rejects.toThrow(/layer boom/);
        expect(currentSession.ended).toBe(true);
    });

    it("ends the session when render-state initialization fails", async () => {
        installXrGlobals({ updateRenderStateError: new Error("render state boom") });
        const scene = createSceneContext(makeMockEngine());

        await expect(enterXr(scene, { input: false })).rejects.toThrow(/render state boom/);
        expect(currentSession.ended).toBe(true);
    });

    it("ends the session when both requested reference spaces fail", async () => {
        installXrGlobals({ grantedRefSpaces: [] });
        const scene = createSceneContext(makeMockEngine());

        await expect(enterXr(scene, { input: false })).rejects.toThrow(/not supported/);
        expect(currentSession.ended).toBe(true);
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

    it("requests local-floor as an optional feature and obtains it", async () => {
        installXrGlobals();
        const scene = createSceneContext(makeMockEngine());
        const ctx = await enterXr(scene, { input: false });
        // Floor-relative spaces are only granted when listed as a session feature; if we
        // forget, the headset origin sits at head height and the floor sinks ~1.5 m.
        expect((lastSessionInit!.optionalFeatures as string[]) ?? []).toContain("local-floor");
        expect(currentSession.requestedRefSpaces).toEqual(["local-floor"]);
        await exitXr(ctx);
    });

    it("falls back to local when the headset cannot grant the floor space", async () => {
        installXrGlobals({ grantedRefSpaces: ["viewer", "local"] });
        const scene = createSceneContext(makeMockEngine());
        const ctx = await enterXr(scene, { input: false });
        expect(currentSession.requestedRefSpaces).toEqual(["local-floor", "local"]);
        await exitXr(ctx);
    });

    it("does not duplicate an explicitly requested reference space in features", async () => {
        installXrGlobals();
        const scene = createSceneContext(makeMockEngine());
        const ctx = await enterXr(scene, { input: false, referenceSpaceType: "local", optionalFeatures: ["local"] });
        // `local` needs no feature entry; it must not be added twice.
        const optional = (lastSessionInit!.optionalFeatures as string[]) ?? [];
        expect(optional.filter((f) => f === "local").length).toBe(1);
        expect(currentSession.requestedRefSpaces).toEqual(["local"]);
        await exitXr(ctx);
    });

    it("merges feature session-features, instantiates, drives, and disposes features", async () => {
        installXrGlobals();
        const scene = createSceneContext(makeMockEngine());
        const update = vi.fn();
        const dispose = vi.fn();
        let created = 0;
        const spec = {
            sessionFeatures: ["hit-test", "local-floor"],
            create: () => {
                created++;
                return { update, dispose };
            },
        };
        const ctx = await enterXr(scene, { input: false, features: [spec] });

        // Session-features merged (deduped against the floor space already requested).
        const optional = (lastSessionInit!.optionalFeatures as string[]) ?? [];
        expect(optional).toContain("hit-test");
        expect(optional.filter((f) => f === "local-floor").length).toBe(1);
        // Instantiated exactly once, after the session exists.
        expect(created).toBe(1);

        // Driven each frame, with or without a viewer pose.
        currentSession.drive(16, makeFrame(makeViewerPose()));
        currentSession.drive(32, makeFrame(null));
        expect(update).toHaveBeenCalledTimes(2);

        await exitXr(ctx);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("rolls back created features and ends the session when one fails to create", async () => {
        installXrGlobals();
        const engine = makeMockEngine();
        const render = vi.fn();
        engine._renderFn = render;
        engine._animFrameId = 7;
        const scene = createSceneContext(engine);
        const disposeOk = vi.fn();
        const onEnd = vi.fn();
        const good = { create: () => ({ dispose: disposeOk }) };
        const bad = {
            create: () => {
                throw new Error("feature boom");
            },
        };
        await expect(enterXr(scene, { input: false, features: [good, bad], onEnd })).rejects.toThrow(/feature boom/);
        // The successfully-created feature was disposed and the session ended.
        expect(disposeOk).toHaveBeenCalledTimes(1);
        expect(currentSession.ended).toBe(true);
        expect(onEnd).not.toHaveBeenCalled();
        // Feature creation happens before XR stops the canvas loop.
        expect(engine._renderFn).toBe(render);
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

    it("continues teardown and resumes the canvas when disposers throw", async () => {
        installXrGlobals();
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const ctx = await enterXr(scene, {
            input: false,
            features: [
                {
                    create: () => ({
                        dispose: () => {
                            throw new Error("dispose boom");
                        },
                    }),
                },
            ],
            onEnd: () => {
                throw new Error("onEnd boom");
            },
        });

        await exitXr(ctx);

        expect(ctx._ended).toBe(true);
        expect(engine._renderFn).not.toBeNull();
        expect(log).toHaveBeenCalledTimes(2);
        log.mockRestore();
    });

    it("flushes pending GPU retirements after XR submission", async () => {
        installXrGlobals();
        const engine = makeMockEngine();
        const retired = vi.fn();
        const scene = createSceneContext(engine);
        const ctx = await enterXr(scene, { input: false });
        engine._retirements = [retired];

        currentSession.drive(16, makeFrame(makeViewerPose()));

        expect(engine._retirements).toBeNull();
        await vi.waitFor(() => expect(retired).toHaveBeenCalledOnce());
        await exitXr(ctx);
    });

    it("ends XR on device loss and resumes only after device recovery", async () => {
        installXrGlobals();
        const engine = makeMockEngine();
        engine._deviceLostRecovery = {
            _forceNextLoss: false,
            _requiredFeatures: [],
            _armedDevice: engine._device,
            _registrations: [{ _kind: "scene", _recover: vi.fn() }],
            _samplerDescriptors: new WeakMap(),
            _captureRefs: 0,
            _meshCaptureRefs: 0,
        };
        const scene = createSceneContext(engine);
        const ctx = await enterXr(scene, { input: false });
        const xrRecovery = engine._deviceLostRecovery._registrations.find((registration) => registration._kind === "xr-session")!;

        xrRecovery._onLost!({} as GPUDeviceLostInfo);
        await Promise.resolve();

        expect(currentSession.ended).toBe(true);
        expect(ctx._ended).toBe(true);
        expect(engine._renderFn).toBeNull();

        void xrRecovery._recover(engine);
        expect(engine._renderFn).not.toBeNull();
    });
});
