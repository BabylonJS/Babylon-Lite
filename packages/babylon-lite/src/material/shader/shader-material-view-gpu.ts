import type { EngineContext } from "../../engine/engine.js";
import { retireGpuResources } from "../../engine/gpu-resource-retirement.js";
import { isShaderMaterial } from "../material-guards.js";
import { isMaterialView } from "../material-view.js";
import type { ShaderMaterial } from "./shader-material.js";

/** @internal Retire the private custom UBO owned by a ShaderMaterial view. */
export function _retireShaderMaterialViewGpu(engine: EngineContext, view: ShaderMaterial): void {
    if (!Object.hasOwn(view, "_shaderCustomUbo") || !view._shaderCustomUbo) {
        return;
    }
    const buffer = view._shaderCustomUbo;
    const owner = Object.hasOwn(view, "_shaderCustomEngine") ? view._shaderCustomEngine : undefined;
    view._shaderCustomUbo = null;
    view._shaderCustomData = null;
    view._shaderCustomBytes = null;
    view._shaderCustomVersion = -1;
    view._shaderCustomEngine = undefined;
    retireGpuResources(owner ?? engine, () => buffer.destroy());
}

/** Abandon a ShaderMaterial view after detaching all its draws. Only its own custom buffer is
 * retired; source/borrowed state and shared bindings remain alive. Recreate a view to use it again. */
export function releaseMaterialViewGpu(engine: EngineContext, view: ShaderMaterial): void {
    if (isMaterialView(view) && isShaderMaterial(view)) {
        _retireShaderMaterialViewGpu(engine, view);
    }
}
