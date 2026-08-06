import type { SceneContext } from "../scene/scene-core.js";
import type { EngineContext } from "../engine/engine.js";
import { startEngine, stopEngine } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createRenderTarget } from "../engine/render-target.js";
import type { RenderTask } from "../frame-graph/render-task.js";
import { createRenderTask } from "../frame-graph/render-task.js";
import type { NormalizedViewport } from "../camera/camera.js";
import type { XrCamera } from "./xr-camera.js";
import { createXrCamera, updateXrCameraForView } from "./xr-camera.js";
import type { XrInputManager, XrInputCallbacks } from "./xr-input.js";
import { createXrInputManager, disposeXrInputManager, updateXrInputPoses } from "./xr-input.js";
import type { XrFeatureSpec, XrFeatureHandle } from "./xr-feature.js";
import type { XrSessionMode, XrReferenceSpaceType } from "./xr-support.js";
import { isWebGpuXrSupported, isWebXrPresent } from "./xr-support.js";
import { enableXrReverseWinding } from "./xr-winding.js";
import type { XrGpuBinding } from "./xr-webgpu-binding.js";

/** Options for {@link enterXr}. All fields optional; sensible immersive-VR defaults. */
export interface XrSessionOptions {
    /** `"immersive-vr"` (default) or `"immersive-ar"`. */
    mode?: XrSessionMode;
    /** Reference space to render against. Defaults to `"local-floor"`, falling back
     *  to `"local"` if the device does not offer it. */
    referenceSpaceType?: XrReferenceSpaceType;
    /** Extra required feature descriptors (merged with the mandatory `"webgpu"`). */
    requiredFeatures?: string[];
    /** Optional feature descriptors. */
    optionalFeatures?: string[];
    /** Projection-layer color format. Defaults to `binding.getPreferredColorFormat()`. */
    colorFormat?: GPUTextureFormat;
    /** Projection-layer depth/stencil format handed to the compositor for reprojection.
     *  Defaults to `"depth24plus"`. Pass `null` to render without a compositor depth
     *  attachment (Babylon Lite then renders color-only — supply your own depth if needed). */
    depthStencilFormat?: GPUTextureFormat | null;
    /** XR projection near-clip distance in metres. Smaller lets objects (e.g. a
     *  controller or a grabbed cube) come right up to the eyes without clipping.
     *  Defaults to `0.02`. */
    depthNear?: number;
    /** XR projection far-clip distance in metres. Defaults to the UA value when
     *  omitted (typically 1000). */
    depthFar?: number;
    /** Input-source callbacks, or `false` to disable input tracking entirely.
     *  Defaults to `{}` (sources tracked, no callbacks). */
    input?: XrInputCallbacks | false;
    /** Opt-in XR features (e.g. `pointerSelection()`). Their native session-feature
     *  descriptors are merged into `optionalFeatures`, and each is instantiated,
     *  driven per frame, and disposed automatically by the session. */
    features?: readonly XrFeatureSpec[];
    /** Called once per `XRFrame` after poses are updated and before rendering. */
    onFrame?: (ctx: XrSessionContext, frame: XRFrame, time: DOMHighResTimeStamp) => void;
    /** Called when the session ends (user exit, `exitXr`, or device-driven). */
    onEnd?: () => void;
}

/** @internal Per-eye render unit: an eager render target, its XR camera, and a scene-mirroring render task. */
interface XrEyeUnit {
    rt: RenderTarget;
    camera: XrCamera;
    task: RenderTask;
    recorded: boolean;
}

/** Handle to an active WebGPU XR session. Pure state; drive lifecycle with {@link exitXr}. */
export interface XrSessionContext {
    readonly mode: XrSessionMode;
    readonly session: XRSession;
    readonly binding: XrGpuBinding;
    readonly layer: XRProjectionLayer;
    /** Active reference space the session renders + tracks input against. Teleportation
     *  swaps this for an offset space to move the viewer. */
    readonly referenceSpace: XRReferenceSpace;
    readonly scene: SceneContext;
    readonly engine: EngineContext;
    readonly colorFormat: GPUTextureFormat;
    readonly depthFormat: GPUTextureFormat | null;
    /** Per-eye cameras, in `XRViewerPose.views` order. Populated on the first frame. */
    readonly cameras: readonly XrCamera[];
    /** Input manager, or `null` when input tracking is disabled. */
    readonly input: XrInputManager | null;

    /** @internal Live feature instances, driven per frame and disposed on end. */
    _features: XrFeatureHandle[];
    /** @internal Mutable backing for {@link referenceSpace}. Teleportation swaps this to
     *  an offset reference space; the public getter always reflects the current one. */
    _referenceSpace: XRReferenceSpace;
    /** @internal */
    _units: XrEyeUnit[];
    /** @internal */
    _options: XrSessionOptions;
    /** @internal */
    _rafId: number;
    /** @internal */
    _lastTime: number;
    /** @internal */
    _ended: boolean;
    /** @internal Saved scene clear color, restored on end (AR forces alpha 0 for passthrough). */
    _savedClear?: { r: number; g: number; b: number; a: number };
}

/**
 * Enter an immersive WebGPU XR session that renders `scene` stereoscopically.
 *
 * Requires the **draft** WebXR/WebGPU binding (`XRGPUBinding`), which no browser
 * implements yet — call {@link isXrSessionSupported} first and gate your UI on it.
 * The engine's adapter **must** be XR-compatible — call {@link enableXrCompatibleAdapter}
 * before `createEngine`; otherwise the binding throws and this rejects.
 * The normal canvas render loop is stopped for the session's duration and resumed
 * when it ends.
 *
 * @param scene - A registered scene (call `registerScene` before entering).
 * @param options - Session configuration; see {@link XrSessionOptions}.
 * @returns The active {@link XrSessionContext}.
 * @throws If WebXR or the WebGPU binding is unavailable, or the session request fails.
 */
export async function enterXr(scene: SceneContext, options: XrSessionOptions = {}): Promise<XrSessionContext> {
    if (!isWebXrPresent()) {
        throw new Error("WebXR is not available (navigator.xr missing).");
    }
    if (!isWebGpuXrSupported()) {
        throw new Error("WebGPU XR is not supported by this browser (XRGPUBinding missing).");
    }

    const mode: XrSessionMode = options.mode ?? "immersive-vr";
    const engine = scene.surface.engine;
    const device = engine._device;

    // Eye targets flip forward-pipeline frontFace to correct the RH-view/LH-raster handedness flip.
    // Install the winding hooks now (idempotent); only reachable from enterXr, so non-XR bundles omit it.
    enableXrReverseWinding();

    const refType = options.referenceSpaceType ?? "local-floor";
    const requiredFeatures = ["webgpu", ...(options.requiredFeatures ?? [])];
    const optionalFeatures = [...(options.optionalFeatures ?? [])];
    // Reference spaces other than `viewer`/`local` are only granted when requested as
    // a session feature; otherwise `requestReferenceSpace(refType)` rejects and we fall
    // back to `local` (origin at head height, which sinks the floor ~1.5 m). Request it
    // as *optional* so headsets without floor tracking still start (then fall back).
    if (refType !== "viewer" && refType !== "local" && !requiredFeatures.includes(refType) && !optionalFeatures.includes(refType)) {
        optionalFeatures.push(refType);
    }
    // Fold each feature's native descriptors into optionalFeatures — they must be
    // requested now, since a session's feature set is fixed once created.
    for (const spec of options.features ?? []) {
        for (const f of spec.sessionFeatures ?? []) {
            if (!requiredFeatures.includes(f) && !optionalFeatures.includes(f)) {
                optionalFeatures.push(f);
            }
        }
    }
    const session = await navigator.xr!.requestSession(mode, {
        requiredFeatures,
        optionalFeatures,
    });

    let binding: XrGpuBinding;
    try {
        binding = new XRGPUBinding(session, device);
    } catch (e) {
        // The draft binding throws InvalidStateError when the device's adapter was not
        // requested with `xrCompatible: true`. WebGPU can't upgrade an existing device,
        // so `enableXrCompatibleAdapter()` must have been called before `createEngine`.
        await session.end().catch(() => {});
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to construct XRGPUBinding: ${detail}. Call enableXrCompatibleAdapter() before createEngine so its GPU adapter is XR-compatible.`, { cause: e });
    }
    const colorFormat = options.colorFormat ?? binding.getPreferredColorFormat();
    const depthFormat = options.depthStencilFormat === undefined ? "depth24plus" : options.depthStencilFormat;
    const layer = binding.createProjectionLayer({
        colorFormat,
        depthStencilFormat: depthFormat ?? undefined,
    });
    await session.updateRenderState({
        layers: [layer],
        depthNear: options.depthNear ?? 0.02,
        ...(options.depthFar !== undefined ? { depthFar: options.depthFar } : {}),
    });

    let referenceSpace: XRReferenceSpace;
    try {
        referenceSpace = await session.requestReferenceSpace(refType);
    } catch {
        referenceSpace = await session.requestReferenceSpace("local");
    }

    // Take over the render loop: the canvas loop must not run while in XR.
    stopEngine(engine);

    const input = options.input === false ? null : createXrInputManager(session, options.input ?? {});

    const ctx: XrSessionContext = {
        mode,
        session,
        binding,
        layer,
        get referenceSpace() {
            return ctx._referenceSpace;
        },
        scene,
        engine,
        colorFormat,
        depthFormat,
        get cameras() {
            return ctx._units.map((u) => u.camera);
        },
        input,
        _features: [],
        _referenceSpace: referenceSpace,
        _units: [],
        _options: options,
        _rafId: 0,
        _lastTime: 0,
        _ended: false,
    };

    // AR passthrough: clear with alpha 0 so the real world shows through. The canvas
    // is not rendering while in XR, so mutating the scene clear color is invisible
    // elsewhere; the original is restored on end.
    if (mode === "immersive-ar") {
        const c = scene.clearColor;
        ctx._savedClear = { r: c.r, g: c.g, b: c.b, a: c.a };
        c.a = 0;
    }

    // Instantiate features now that the session, reference space, and input exist.
    // On failure, roll back anything already created and end the session cleanly.
    try {
        for (const spec of options.features ?? []) {
            ctx._features.push(spec.create(ctx));
        }
    } catch (e) {
        for (const f of ctx._features) {
            f.dispose?.();
        }
        ctx._features.length = 0;
        await session.end().catch(() => {});
        throw e instanceof Error ? e : new Error(String(e));
    }

    session.addEventListener("end", () => cleanup(ctx), { once: true });
    ctx._rafId = session.requestAnimationFrame((time, frame) => onXrFrame(ctx, time, frame));
    return ctx;
}

/** End an active XR session. Safe to call repeatedly; resolves once the session has ended. */
export async function exitXr(ctx: XrSessionContext): Promise<void> {
    if (!ctx._ended) {
        await ctx.session.end();
    }
}

/** @internal Lazily create the per-eye render unit (eager RT + XR camera + scene-mirroring task). */
function ensureUnit(ctx: XrSessionContext, index: number, eye: XREye): XrEyeUnit {
    const existing = ctx._units[index];
    if (existing) {
        return existing;
    }
    const layer = ctx.layer;
    const rt = createRenderTarget({
        lbl: `xr-eye-${index}`,
        format: ctx.colorFormat,
        dFormat: ctx.depthFormat ?? undefined,
        samples: 1,
        size: { width: layer.textureWidth, height: layer.textureHeight },
        // XR view/projection are consumed verbatim in their native right-handed form;
        // the handedness flip vs Lite's left-handed rasterizer inverts apparent winding,
        // so flip the forward pipelines' frontFace (ccw→cw) to keep the scene's front
        // faces visible — and double-sided normals correct — in the headset.
        _reverseWinding: true,
    });
    // Eager: textures are owned by the XR compositor and supplied per frame, so the
    // frame graph must neither allocate nor destroy them (disposeRenderTarget no-ops).
    rt._eager = true;
    const camera = createXrCamera(eye);
    const task = createRenderTask({ name: `xr-eye-${index}`, rt, clr: true, cam: camera }, ctx.engine, ctx.scene);
    const unit: XrEyeUnit = { rt, camera, task, recorded: false };
    ctx._units[index] = unit;
    return unit;
}

/** @internal The per-`XRFrame` render callback: one scene update, then one render task per view. */
function onXrFrame(ctx: XrSessionContext, time: DOMHighResTimeStamp, frame: XRFrame): void {
    if (ctx._ended) {
        return;
    }
    ctx._rafId = ctx.session.requestAnimationFrame((t, f) => onXrFrame(ctx, t, f));

    const pose = frame.getViewerPose(ctx.referenceSpace);
    if (ctx.input) {
        updateXrInputPoses(ctx.input, frame, ctx.referenceSpace);
    }
    ctx._options.onFrame?.(ctx, frame, time);
    // Drive features after input poses + the app's onFrame, before rendering, so their
    // scene mutations (e.g. pointer laser transforms) are picked up by `scene._update`.
    for (const f of ctx._features) {
        f.update?.(frame, time);
    }
    if (!pose) {
        // No tracking this frame — skip rendering but keep the loop alive.
        return;
    }

    const eng = ctx.engine;
    const delta = ctx._lastTime ? time - ctx._lastTime : 0;
    ctx._lastTime = time;

    const encoder = eng._device.createCommandEncoder({ label: "xr-frame" });
    const prevEncoder = eng._currentEncoder;
    const prevDelta = eng._currentDelta;
    eng._currentEncoder = encoder;
    eng._currentDelta = ctx.scene.fixedDeltaMs > 0 ? ctx.scene.fixedDeltaMs : delta;

    // Scene-wide per-frame work (animations, pre-passes, uniform updaters) — once,
    // shared by both eyes. Records into the XR command encoder.
    ctx.scene._update();

    const views = pose.views;
    const texW = ctx.layer.textureWidth;
    const texH = ctx.layer.textureHeight;
    for (let i = 0; i < views.length; i++) {
        const view = views[i]!;
        const subImage = ctx.binding.getViewSubImage(ctx.layer, view);
        const unit = ensureUnit(ctx, i, view.eye);

        const viewDesc = subImage.getViewDescriptor();
        const colorView = subImage.colorTexture.createView(viewDesc);
        const depthTex = subImage.depthStencilTexture;
        const depthView = depthTex ? depthTex.createView(viewDesc) : null;

        const rt = unit.rt;
        rt._colorTexture = subImage.colorTexture;
        rt._colorView = colorView;
        rt._depthTexture = depthTex;
        rt._depthView = depthView;
        rt._width = texW;
        rt._height = texH;

        // Build the task once (after the first frame's views/targets exist). Subsequent
        // frames only swap the per-frame attachment views — the compositor returns fresh
        // GPUTextures each frame from a double/triple-buffered swap chain.
        if (!unit.recorded) {
            unit.task.record();
            unit.recorded = true;
        }
        unit.task._colorAttachment.view = colorView;
        const dsa = unit.task._renderPassDescriptor.depthStencilAttachment;
        if (dsa && depthView) {
            dsa.view = depthView;
        }

        const vp = subImage.viewport;
        const viewport: NormalizedViewport = { x: vp.x / texW, y: vp.y / texH, width: vp.width / texW, height: vp.height / texH };
        updateXrCameraForView(unit.camera, view, texW, texH, viewport);
        unit.task.execute?.();
    }

    eng._device.queue.submit([encoder.finish()]);
    eng._currentEncoder = prevEncoder;
    eng._currentDelta = prevDelta;
}

/** @internal Tear down a session: stop the loop, dispose per-eye tasks + input, restore state, resume canvas. */
function cleanup(ctx: XrSessionContext): void {
    if (ctx._ended) {
        return;
    }
    ctx._ended = true;
    if (ctx._rafId) {
        ctx.session.cancelAnimationFrame(ctx._rafId);
        ctx._rafId = 0;
    }
    // Dispose features before input/tasks — they may reference the input manager or scene.
    for (const f of ctx._features) {
        f.dispose?.();
    }
    ctx._features.length = 0;
    if (ctx.input) {
        disposeXrInputManager(ctx.input);
    }
    for (const u of ctx._units) {
        u.task.dispose();
    }
    ctx._units.length = 0;
    if (ctx._savedClear) {
        const c = ctx.scene.clearColor;
        c.r = ctx._savedClear.r;
        c.g = ctx._savedClear.g;
        c.b = ctx._savedClear.b;
        c.a = ctx._savedClear.a;
        ctx._savedClear = undefined;
    }
    ctx._options.onEnd?.();
    // Resume the normal canvas render loop.
    void startEngine(ctx.engine);
}
