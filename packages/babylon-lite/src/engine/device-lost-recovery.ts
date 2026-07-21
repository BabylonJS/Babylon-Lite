import { TU } from "./gpu-flags.js";
import type { EngineContext } from "./engine.js";
import { startEngine, stopEngine, resizeEngine } from "./engine.js";
import { _refreshScRT } from "./surface.js";
import { clearSceneBGLCache } from "../render/scene-helpers.js";

export interface DeviceLostRecoveryOptions {
    onLost?: (info: GPUDeviceLostInfo) => void;
    onRecovered?: () => void;
    onRecoveryFailed?: (error: unknown) => void;
}

export interface DeviceLostRecoveryHandle {
    disable(): void;
}

interface RecoveryState {
    enabled: boolean;
    recovering: boolean;
    forceNextLoss: boolean;
    requiredFeatures: GPUFeatureName[];
    armedDevice: GPUDevice | null;
    options: DeviceLostRecoveryOptions;
}

let _states: WeakMap<EngineContext, RecoveryState> | null = null;

function states(): WeakMap<EngineContext, RecoveryState> {
    if (!_states) {
        _states = new WeakMap();
    }
    return _states;
}

function getState(engine: EngineContext): RecoveryState {
    let state = states().get(engine);
    if (!state) {
        state = {
            enabled: false,
            recovering: false,
            forceNextLoss: false,
            requiredFeatures: [],
            armedDevice: null,
            options: {},
        };
        states().set(engine, state);
    }
    return state;
}

export function enableDeviceLostRecovery(engine: EngineContext, options: DeviceLostRecoveryOptions = {}): DeviceLostRecoveryHandle {
    const state = getState(engine);
    state.enabled = true;
    state.options = options;
    state.requiredFeatures = Array.from(engine._device.features) as GPUFeatureName[];
    attachRecoveryCapture(engine);

    arm(engine, state);
    return {
        disable(): void {
            state.enabled = false;
            detachRecoveryCapture(engine);
        },
    };
}

function attachRecoveryCapture(engine: EngineContext): void {
    engine._dlr = {
        u(tex, url, opts) {
            tex._recoverySource = { kind: "url", url, opts: { ...opts } };
        },
        s(tex, r, g, b, a) {
            tex._recoverySource = { kind: "solid", rgba: [r, g, b, a] };
        },
        b(tex, bitmap, srgb, mipMaps, fallback) {
            tex._recoverySource = {
                kind: "bitmap",
                bitmap,
                srgb,
                mipMaps,
                fallback,
                samplerDesc: { magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 4 },
            };
        },
        m(mesh, uv2s, tangents, colors, gpuIndices, indexFormat) {
            mesh._cpuUv2s = uv2s;
            mesh._cpuTangents = tangents;
            mesh._cpuColors = colors;
            mesh._cpuGpuIndices = gpuIndices;
            mesh._cpuIndexFormat = indexFormat;
        },
    };
}

function detachRecoveryCapture(engine: EngineContext): void {
    engine._dlr = undefined;
}

export function markNextDeviceLossForRecovery(engine: EngineContext): boolean {
    const state = _states?.get(engine as EngineContext);
    if (!state?.enabled) {
        return false;
    }
    state.forceNextLoss = true;
    return true;
}

function arm(engine: EngineContext, state: RecoveryState): void {
    const device = engine._device;
    if (state.armedDevice === device) {
        return;
    }
    state.armedDevice = device;
    void device.lost.then(async (info) => {
        if (!state.enabled || state.armedDevice !== device) {
            return;
        }
        const forced = state.forceNextLoss;
        state.forceNextLoss = false;
        if (info.reason === "destroyed" && !forced) {
            return;
        }
        state.options.onLost?.(info);
        try {
            await recoverDevice(engine, state);
            if (state.enabled) {
                arm(engine, state);
            }
            state.options.onRecovered?.();
        } catch (error) {
            state.options.onRecoveryFailed?.(error);
        }
    });
}

async function recoverDevice(engine: EngineContext, state: RecoveryState): Promise<void> {
    if (state.recovering) {
        return;
    }
    state.recovering = true;
    const wasRunning = engine._renderFn !== null;
    stopEngine(engine);

    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) {
            throw new Error("WebGPU adapter not available during device recovery");
        }
        const missingFeatures = state.requiredFeatures.filter((f) => !adapter.features.has(f));
        if (missingFeatures.length) {
            throw new Error(`WebGPU device recovery missing required features: ${missingFeatures.join(", ")}`);
        }
        engine._device = await adapter.requestDevice({
            requiredFeatures: state.requiredFeatures,
            requiredLimits: { ...engine._options?.requiredLimits, ...engine._storageRequiredLimits },
        });
        engine._rebuildStorageBuffers?.();
        // Reconfigure every surface's canvas context against the new device and re-acquire
        // its swapchain texture (the previous device's textures are invalid). The rebuilt
        // frame graphs need fresh color attachments. Per-surface `_swapchainCopySrc` is
        // honoured so surfaces that had been promoted to COPY_SRC for screenshot readback
        // keep that capability across recovery; surfaces that never captured stay
        // RENDER_ATTACHMENT-only.
        for (const surface of engine.surfaces) {
            const usage = surface._swapchainCopySrc ? TU.RENDER_ATTACHMENT | TU.COPY_SRC : TU.RENDER_ATTACHMENT;
            surface._context.configure({
                device: engine._device,
                format: surface._configureFormat,
                alphaMode: surface._alphaMode,
                usage,
                viewFormats: [surface.format],
            });
            _refreshScRT(surface);
        }

        clearSceneBGLCache();
        resizeEngine(engine);

        // The whole scene-rebuild subtree (meshes, frame-graph tasks, textures,
        // skeletons, morph targets) runs only here on the recovery path, so it
        // lives in its own module reached through this single lazy import. The
        // always-bundled recovery orchestrator carries none of it statically.
        const { rebuildRegisteredScenes } = await import("./recovery-rebuild.js");
        await rebuildRegisteredScenes(engine);
    } finally {
        state.recovering = false;
    }

    if (wasRunning) {
        await startEngine(engine);
    }
}
