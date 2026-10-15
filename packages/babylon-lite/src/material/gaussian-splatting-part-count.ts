import { getEngineLimits } from "../engine/engine-gpu-events.js";
import type { EngineContext } from "../engine/engine.js";

/** Maximum Gaussian-splat compound parts supported by the engine's uniform-buffer limit. */
export function getGaussianSplattingMaxPartCount(engine: EngineContext): number {
    const maxUniformVectors = Math.floor(getEngineLimits(engine).maxUniformBufferBindingSize / 4);
    const maxFromUniforms = Math.floor(Math.max(maxUniformVectors - 40, 0) / 5);
    return Math.min(Math.max(maxFromUniforms, 1), 256);
}
