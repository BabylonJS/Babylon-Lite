import type { GeometryRendererTask } from "./geometry-renderer-task.js";
import * as pbrVelocity from "../material/pbr/pbr-geometry-velocity.js";
import * as deformation from "../material/geometry-deformation-velocity.js";
import { installPbrGeometryVelocity } from "../material/pbr/pbr-geometry-velocity-hooks.js";
import { installGeometryDeformationVelocity } from "../material/geometry-deformation-hooks.js";

export interface GeometryVelocityOptions {
    /** Store previous positive view depth in velocity Z; requires a perspective camera and floating-point RGBA target. */
    previousDepth?: boolean;
}

let enabled: WeakMap<GeometryRendererTask, boolean> | null = null;

/**
 * Enable previous material-point motion for PBR/Standard geometry before scene registration.
 * The ordinary geometry path keeps its existing behavior and does not retain this feature.
 */
export function enableGeometryVelocity(task: GeometryRendererTask, options: GeometryVelocityOptions = {}): void {
    const target = task.geometryLinearVelocityTexture;
    if (!target || target._disposed || !task._paramsData) {
        throw new Error("Geometry velocity requires a live LINEAR_VELOCITY attachment.");
    }
    const previousDepth = options.previousDepth ?? false;
    if (enabled?.has(task)) {
        if (enabled.get(task) !== previousDepth) {
            throw new Error("Geometry velocity was already enabled with a different previous-depth contract.");
        }
        return;
    }
    if (previousDepth && !["rgba16float", "rgba32float"].includes(target._descriptor.format ?? "")) {
        throw new Error("Geometry previous-depth velocity requires a floating-point RGBA velocity attachment.");
    }
    if (task.scene?._built) {
        throw new Error("Enable geometry velocity before registering the scene.");
    }
    task._paramsData[18] = previousDepth ? 1 : 0;
    const previousValidation = task._validateCamera;
    if (previousDepth) {
        task._validateCamera = (camera) => {
            previousValidation?.(camera);
            if (camera.ortho) {
                throw new Error("Geometry previous-depth velocity requires a perspective camera.");
            }
        };
    }
    installPbrGeometryVelocity(pbrVelocity);
    installGeometryDeformationVelocity(deformation, pbrVelocity.geometryVelocityOutput);
    const preload = task._preload!;
    task._preload = async () => {
        await preload();
        const create = task._createPbrGeometryView;
        if (create) {
            task._createPbrGeometryView = (source, config) => {
                const view = create(source, config);
                view._geometryVelocity = true;
                return view;
            };
        }
    };
    (enabled ??= new WeakMap()).set(task, previousDepth);
}
