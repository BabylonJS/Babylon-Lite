import type { EngineContextInternal } from "../engine/engine.js";
import type { FogConfig } from "./standard/standard-material.js";

const SCENE_UNIFORM_FLOATS = 44;
let _sceneUniformScratch: Float32Array<ArrayBuffer> | null = null;

export function updateSceneUniforms(
    engine: EngineContextInternal,
    sceneUBO: GPUBuffer,
    viewProjection: Float32Array,
    viewMatrix: Float32Array,
    eyePosition: [number, number, number],
    fog?: FogConfig
): void {
    const device = engine.device;
    if (!_sceneUniformScratch) {
        _sceneUniformScratch = new Float32Array(SCENE_UNIFORM_FLOATS);
    }
    const data = _sceneUniformScratch;
    data.fill(0);
    data.set(viewProjection, 0);
    data.set(viewMatrix, 16);
    data[32] = eyePosition[0];
    data[33] = eyePosition[1];
    data[34] = eyePosition[2];
    if (fog) {
        data[36] = fog.mode;
        data[37] = fog.start;
        data[38] = fog.end;
        data[39] = fog.density;
        data[40] = fog.color[0];
        data[41] = fog.color[1];
        data[42] = fog.color[2];
    }
    device.queue.writeBuffer(sceneUBO, 0, data);
}
