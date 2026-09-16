import type { EngineContext } from "../engine/engine.js";
import type { MeshGPU } from "./mesh.js";

/** @internal Optional defaults for geometry with an authoritative vertex range. */
export interface VertexDefaults {
    /** @internal */
    _buffer(engine: EngineContext, gpu: MeshGPU): GPUBuffer | null;
    /** @internal */
    _layouts(layouts: readonly GPUVertexBufferLayout[], names: readonly string[], gpu: MeshGPU): readonly GPUVertexBufferLayout[];
}

/** @internal Installed only by GPU-backed geometry; otherwise folded out of renderers. */
export let _vertexDefaults: VertexDefaults | null = null;

/** @internal */
export function _installVertexDefaults(defaults: VertexDefaults): void {
    _vertexDefaults = defaults;
}
