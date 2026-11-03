import type { RenderTarget } from "../engine/render-target.js";
import type { SsaoTask } from "./ssao.js";
import type { XegtaoTemporalGpu } from "./ssao-xegtao-gpu.js";
import { bindXegtaoTemporalGpu, createXegtaoTemporalGpu, disposeXegtaoTemporalGpu, executeXegtaoTemporalGpu } from "./ssao-xegtao-gpu.js";
import { getEffectiveAspectRatio, getViewProjectionMatrix } from "../camera/camera.js";
import { createIdentityMat4 } from "../math/create-identity-mat4.js";
import { invertMat4ToRefOrIdentity } from "../math/invert-mat4-to-ref-or-identity.js";
import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";
import { mat4Determinant3 } from "../math/mat4-determinant3.js";
import type { Mat4, Mat4Storage } from "../math/types.js";

export interface SsaoTemporalOptions {
    /** Initial reconstruction state. Default true; change task.temporal.enabled for live toggles. */
    enabled?: boolean;
    /** Previous-minus-current NDC XY / 2, Y up. Omit only for static geometry. */
    velocityTexture?: RenderTarget;
    /** RGBA velocity Z contains previous positive view depth. Default false. */
    velocityHasPreviousDepth?: boolean;
    /** Maximum accumulated history samples, 1..16 (the native reconstruction length). Default 16. */
    historySamples?: number;
}

/** Plain state; use resetSsaoTemporal for cuts or externally changed scene content. */
export interface SsaoTemporalSettings {
    enabled: boolean;
    historySamples: number;
    resetVersion: number;
    /** @internal Installed only by an explicit GPU-extension enabler. */
    _prepareGpu?: (state: XegtaoTemporalGpu, velocity: GPUTextureView | null) => void;
}

interface Entry {
    settings: SsaoTemporalSettings;
    velocity: RenderTarget | null;
    previousDepth: boolean;
}
let _states: WeakMap<SsaoTask, Entry> | null = null;

/** @internal Read the installed temporal contract without implicitly enabling it. */
export function getSsaoTemporalEntry(task: SsaoTask): Entry | undefined {
    return _states?.get(task);
}

function copyMatrix(target: Mat4, source: Mat4): void {
    const storage = target as unknown as Mat4Storage;
    for (let i = 0; i < 16; i++) {
        storage[i] = source[i]!;
    }
}
/** @internal Reject invalid mutable history settings rather than silently clamping. */
export function validateSsaoTemporalSettings(settings: SsaoTemporalSettings): void {
    if (typeof settings.enabled !== "boolean") {
        throw new Error("SSAO temporal enabled must be a boolean.");
    }
    if (!Number.isInteger(settings.historySamples) || settings.historySamples < 1 || settings.historySamples > 16) {
        throw new Error("SSAO temporal historySamples must be an integer in [1, 16].");
    }
    if (!Number.isSafeInteger(settings.resetVersion) || settings.resetVersion < 0) {
        throw new Error("SSAO temporal resetVersion must be a nonnegative safe integer.");
    }
}

/** Invalidate temporal history at a known camera cut or scene-content discontinuity. */
export function resetSsaoTemporal(settings: SsaoTemporalSettings): void {
    validateSsaoTemporalSettings(settings);
    if (settings.resetVersion === Number.MAX_SAFE_INTEGER) {
        throw new Error("SSAO temporal resetVersion cannot be incremented further.");
    }
    settings.resetVersion++;
}

/** @internal Initialize a new task's reconstruction from the factory, independent of full-scene TAA. */
export function initializeSsaoTemporal(task: SsaoTask, options: SsaoTemporalOptions): void {
    const settings = task.temporal;
    validateSsaoTemporalSettings(settings);
    if (settings.enabled && task.engine.useFloatingOrigin) {
        throw new Error("Temporal SSAO currently does not support floating-origin reprojection.");
    }
    const velocity = options.velocityTexture ?? null;
    const previousDepth = options.velocityHasPreviousDepth === undefined ? false : options.velocityHasPreviousDepth;
    if (typeof previousDepth !== "boolean") {
        throw new Error("SSAO temporal velocityHasPreviousDepth must be a boolean.");
    }
    if (velocity && (velocity._descriptor.samples !== 1 || !["rg16float", "rg32float", "rgba16float", "rgba32float"].includes(velocity._descriptor.format ?? ""))) {
        throw new Error("Temporal SSAO velocity must be a single-sample signed floating-point RG/RGBA target.");
    }
    if (previousDepth && (!velocity || !["rgba16float", "rgba32float"].includes(velocity._descriptor.format ?? ""))) {
        throw new Error("Temporal SSAO previous-depth velocity requires a floating-point RGBA target.");
    }
    const states = (_states ??= new WeakMap());
    const halfVelocity = velocity?._descriptor.format === "rg16float" || velocity?._descriptor.format === "rgba16float";
    const inverse = createIdentityMat4();
    const currentView = createIdentityMat4();
    const previousView = createIdentityMat4();
    const previousProjection = createIdentityMat4();
    const previousInverse = createIdentityMat4();
    const inverseProjection = createIdentityMat4();
    const previousInverseProjection = createIdentityMat4();
    let owner: XegtaoTemporalGpu | null = null;
    let valid = false;
    let phase = 0;
    let resetVersion = -1;
    let historySamples = 0;
    let radius = 0,
        intensity = 0,
        tanX = 0,
        tanY = 0,
        near = 0,
        far = 0;
    let quality = task.quality;
    let viewChanged = true;
    let disposed = false;
    const reset = (): void => {
        valid = false;
        phase = 0;
    };
    task._filter = {
        prepare(gpu, params) {
            if (disposed) {
                throw new Error("Temporal SSAO filter has been disposed.");
            }
            validateSsaoTemporalSettings(settings);
            params.phase = 0;
            if (owner && (owner.owner !== gpu || !!owner.sourceNormal !== !!gpu.sourceNormal)) {
                disposeXegtaoTemporalGpu(owner);
                owner = null;
                reset();
            }
            if (!settings.enabled) {
                if (owner?.owner === gpu) {
                    settings._prepareGpu?.(owner, owner.velocity);
                    bindXegtaoTemporalGpu(owner, owner.velocity);
                    gpu.resolveGroup = owner.baseResolve;
                }
                reset();
                return;
            }
            if (task.engine.useFloatingOrigin) {
                throw new Error("Temporal SSAO currently does not support floating-origin reprojection.");
            }
            const width = gpu.outputTexture?.width ?? gpu.width;
            const height = gpu.outputTexture?.height ?? gpu.height;
            const velocityView = velocity ? (gpu.sourceVelocity ?? velocity._colorView) : null;
            if (velocity && (!velocity._colorView || velocity._width !== width || velocity._height !== height)) {
                throw new Error("Temporal SSAO velocity and depth must be built with identical dimensions.");
            }
            if (!owner) {
                owner = createXegtaoTemporalGpu(gpu, velocityView, !!velocity, previousDepth);
                reset();
            }
            if (owner.sourceDepth !== gpu.sourceDepth || owner.sourceNormal !== gpu.sourceNormal || owner.velocity !== velocityView) {
                reset();
            }
            settings._prepareGpu?.(owner, velocityView);
            bindXegtaoTemporalGpu(owner, velocityView);
            gpu.resolveGroup = owner.scratchResolve;
            if (
                resetVersion !== settings.resetVersion ||
                historySamples !== settings.historySamples ||
                radius !== task.radius ||
                intensity !== task.intensity ||
                quality !== task.quality ||
                tanX !== params.tanX ||
                tanY !== params.tanY ||
                near !== task.camera.nearPlane ||
                far !== task.camera.farPlane
            ) {
                reset();
            }
            resetVersion = settings.resetVersion;
            historySamples = settings.historySamples;
            radius = task.radius;
            intensity = task.intensity;
            quality = task.quality;
            tanX = params.tanX;
            tanY = params.tanY;
            near = task.camera.nearPlane;
            far = task.camera.farPlane;
            const view = params.view!;
            viewChanged = false;
            for (let i = 0; i < 16; i++) {
                if (!Number.isFinite(view[i])) {
                    throw new Error("Temporal SSAO requires finite camera matrices.");
                }
                viewChanged ||= currentView[i] !== view[i];
            }
            if (viewChanged) {
                if (Math.abs(mat4Determinant3(view)) < 1e-10) {
                    throw new Error("Temporal SSAO cannot reproject a singular camera view.");
                }
                copyMatrix(currentView, view);
                invertMat4ToRefOrIdentity(currentView, inverse);
            }
            if (valid) {
                const dx = inverse[12]! - previousInverse[12]!,
                    dy = inverse[13]! - previousInverse[13]!,
                    dz = inverse[14]! - previousInverse[14]!;
                const direction = inverse[8]! * previousInverse[8]! + inverse[9]! * previousInverse[9]! + inverse[10]! * previousInverse[10]!;
                if (dx * dx + dy * dy + dz * dz > Math.max(1, task.radius * 8) ** 2 || direction < 0.7) {
                    reset();
                }
            }
            const data = owner.data;
            packMat4IntoF32(data, inverse, 0);
            packMat4IntoF32(data, previousView, 16);
            packMat4IntoF32(data, previousProjection, 32);
            // Control: x = reset, y = history limit, z = reserved, w = previous-depth velocity contract.
            data[48] = valid ? 0 : 1;
            data[49] = settings.historySamples;
            data[51] = previousDepth ? 1 : 0;
            if (!valid || viewChanged) {
                invertMat4ToRefOrIdentity(getViewProjectionMatrix(task.camera, getEffectiveAspectRatio(task.camera, width, height)), inverseProjection);
            }
            packMat4IntoF32(data, inverseProjection, 52);
            packMat4IntoF32(data, previousInverseProjection, 68);
            // Half-float velocity rounds to 2^-11 relative; tolerate twice that before calling a pixel moving.
            data[84] = halfVelocity ? 2 ** -10 : 1e-5;
            data[85] = halfVelocity ? 2 ** -10 : 0;
            // Row 3 of previousVP * inverse(VP), and row 3 of inverse(VP), in double precision.
            for (let column = 0; column < 4; column++) {
                let w = 0;
                for (let k = 0; k < 4; k++) {
                    w += previousProjection[k * 4 + 3]! * inverseProjection[column * 4 + k]!;
                }
                data[88 + column] = w;
                data[92 + column] = inverseProjection[column * 4 + 3]!;
            }
            params.phase = phase;
        },
        execute(gpu, encoder) {
            if (!settings.enabled) {
                return;
            }
            executeXegtaoTemporalGpu(owner!, encoder);
            copyMatrix(previousView, currentView);
            copyMatrix(previousInverse, inverse);
            copyMatrix(
                previousProjection,
                getViewProjectionMatrix(task.camera, getEffectiveAspectRatio(task.camera, gpu.outputTexture?.width ?? gpu.width, gpu.outputTexture?.height ?? gpu.height))
            );
            copyMatrix(previousInverseProjection, inverseProjection);
            valid = true;
            phase = (phase + 1) % 64;
        },
        reset,
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            if (owner) {
                disposeXegtaoTemporalGpu(owner);
            }
            states.delete(task);
        },
    };
    states.set(task, { settings, velocity, previousDepth });
}
