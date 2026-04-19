import type { EngineContextInternal } from "../engine/engine.js";

/** Create a BGL with a single `uniform` buffer entry at binding 0.
 *  Used for scene/mesh/skybox UBOs that only bind one uniform buffer. */
export function createSingleUniformBGL(engine: EngineContextInternal, label: string, visibility: GPUShaderStageFlags): GPUBindGroupLayout {
    return engine.device.createBindGroupLayout({
        label,
        entries: [{ binding: 0, visibility, buffer: { type: "uniform" } }],
    });
}
