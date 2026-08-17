import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { createSingleUniformBGL } from "../shader/bgl-helpers.js";

let _device: GPUDevice | null = null;
let _layout: GPUBindGroupLayout | null = null;
let _emptyLayout: GPUBindGroupLayout | null = null;

function invalidate(engine: EngineContext): void {
    if (_device !== engine._device) {
        _device = engine._device;
        _layout = null;
        _emptyLayout = null;
    }
}

export function getPickingSceneBGL(engine: EngineContext): GPUBindGroupLayout {
    invalidate(engine);
    return (_layout ??= createSingleUniformBGL(engine, "picking-scene-bgl", SS.VERTEX | SS.FRAGMENT));
}

/** Empty group(2) filler. Bind group layouts must be contiguous from 0, so a pick pipeline that has a
 *  vertex projection at group(3) but no discard rule needs a placeholder in between. */
export function getPickingEmptyBGL(engine: EngineContext): GPUBindGroupLayout {
    invalidate(engine);
    return (_emptyLayout ??= engine._device.createBindGroupLayout({ label: "picking-empty-bgl", entries: [] }));
}
