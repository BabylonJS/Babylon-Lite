import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { createSingleUniformBGL } from "../shader/bgl-helpers.js";

let _device: GPUDevice | null = null;
let _layout: GPUBindGroupLayout | null = null;

export function getPickingSceneBGL(engine: EngineContext): GPUBindGroupLayout {
    if (_device !== engine._device) {
        _device = engine._device;
        _layout = null;
    }
    return (_layout ??= createSingleUniformBGL(engine, "picking-scene-bgl", SS.VERTEX | SS.FRAGMENT));
}
