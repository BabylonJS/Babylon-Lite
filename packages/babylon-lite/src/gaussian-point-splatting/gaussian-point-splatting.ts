import type { SceneContext } from "../scene/scene-core.js";
import type { GaussianSplattingMesh } from "../mesh/GaussianSplatting/gaussian-splatting-mesh.js";
import type { GaussianSplatStream } from "../loader-splat-stream/splat-stream-types.js";
import { createGpsRenderable } from "./gps-runtime.js";
import { gpsOptionsKey, type GaussianPointSplatting } from "./gps-state.js";
import { installGpsDrawSuppression } from "./gps-suppression.js";

export type { GaussianPointSplatting, GaussianPointSplattingProgress } from "./gps-state.js";

/** Initial mutable options; changing the returned handle takes effect on the next frame. */
export type GaussianPointSplattingOptions = Partial<
    Pick<
        GaussianPointSplatting,
        "colorRenderMode" | "depthRenderMode" | "depthVisualization" | "pointScale" | "renderScale" | "occlusionCulling" | "maxAccumFrames" | "temporalReprojection"
    >
>;

let enabled: WeakMap<SceneContext, Map<GaussianSplattingMesh | GaussianSplatStream, GaussianPointSplatting>> | null = null;
let owners: WeakMap<GaussianSplattingMesh | GaussianSplatStream, SceneContext> | null = null;

/** Enable stochastic Gaussian rendering, before registration or while the scene is running. */
export function enableGaussianPointSplatting(
    scene: SceneContext,
    target: GaussianSplattingMesh | GaussianSplatStream,
    options: GaussianPointSplattingOptions = {}
): GaussianPointSplatting {
    const previous = enabled?.get(scene)?.get(target);
    if (previous && !previous._disabled) {
        gpsOptionsKey({ ...previous, ...options });
        Object.assign(previous, options);
        return previous;
    }
    const owner = owners?.get(target);
    if (owner && owner !== scene) {
        throw new Error("Gaussian point splatting target is already enabled in another scene");
    }
    if ("_engine" in target && (target._disposed || target._engine !== scene.surface.engine)) {
        throw new Error("Gaussian point splatting requires a live target on the scene's engine");
    }
    const gps: GaussianPointSplatting = {
        colorRenderMode: options.colorRenderMode ?? true,
        depthRenderMode: options.depthRenderMode ?? false,
        depthVisualization: options.depthVisualization ?? "none",
        pointScale: options.pointScale ?? 1,
        renderScale: options.renderScale ?? "auto",
        occlusionCulling: options.occlusionCulling ?? false,
        maxAccumFrames: options.maxAccumFrames ?? 255,
        temporalReprojection: options.temporalReprojection ?? false,
        get progress() {
            return this._progress;
        },
        _progress: null,
        _target: target,
        _disabled: false,
        _dataVersion: 0,
        _dispose: null,
    };
    gpsOptionsKey(gps);
    const { renderable, dispose } = createGpsRenderable(scene, gps);
    const staticMesh = "_kind" in target && target._kind === "gs-mesh" ? target : null;
    const updateData = staticMesh?.updateData;
    const trackedUpdate: GaussianSplattingMesh["updateData"] = (data) => {
        updateData!.call(staticMesh, data);
        gps._dataVersion++;
    };
    if (staticMesh) {
        staticMesh.updateData = trackedUpdate;
    }
    (enabled ??= new WeakMap()).get(scene) ?? enabled.set(scene, new Map());
    enabled.get(scene)!.set(target, gps);
    (owners ??= new WeakMap()).set(target, scene);
    scene._renderables.push(renderable);
    scene._renderables.sort((a, b) => a.order - b.order);
    scene._renderableVersion++;
    const restoreSuppression = installGpsDrawSuppression(scene, gps, renderable);
    gps._dispose = (): void => {
        if (gps._disabled) {
            return;
        }
        gps._disabled = true;
        restoreSuppression();
        if (staticMesh && staticMesh.updateData === trackedUpdate && updateData) {
            staticMesh.updateData = updateData;
        }
        const index = scene._renderables.indexOf(renderable);
        if (index >= 0) {
            scene._renderables.splice(index, 1);
        }
        const disposeIndex = scene._disposables.indexOf(gps._dispose!);
        if (disposeIndex >= 0) {
            scene._disposables.splice(disposeIndex, 1);
        }
        enabled?.get(scene)?.delete(target);
        owners?.delete(target);
        scene._renderableVersion++;
        gps._progress = null;
        gps._dispose = null;
        dispose();
    };
    scene._disposables.push(gps._dispose);
    return gps;
}

/** Disable and release a point renderer, restoring the classic draw and mesh data updater. */
export function disableGaussianPointSplatting(scene: SceneContext, gps: GaussianPointSplatting): void {
    if (enabled?.get(scene)?.get(gps._target) === gps) {
        gps._dispose?.();
    }
}
