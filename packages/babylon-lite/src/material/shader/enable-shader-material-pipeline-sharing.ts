import { _getShaderDeviceCache, _serializeShaderVertexBuffers, _setShaderVertexBuffersKey } from "./shader-pipeline-cache.js";
import { _setSharedShaderPipelineCache } from "./shader-pipeline.js";

let _vertexBuffersKeys: WeakMap<readonly GPUVertexBufferLayout[], string> | null = null;

/** Share layouts, shader modules and pipelines between every ShaderMaterial, including materials and
 *  material views created after the first scene build. Materials whose generated WGSL, layout and pipeline
 *  state are equal then compile once per device instead of once per material instance. */
export function enableShaderMaterialPipelineSharing(): void {
    _setShaderVertexBuffersKey(vertexBuffersKey);
    _setSharedShaderPipelineCache((device, material) => {
        const current = _getShaderDeviceCache(device);
        if (material._shaderPipelineCache !== current) {
            material._shaderPipelineCache = current;
        }
    });
}

function vertexBuffersKey(vertexBuffers: readonly GPUVertexBufferLayout[]): string {
    _vertexBuffersKeys ??= new WeakMap();
    let key = _vertexBuffersKeys.get(vertexBuffers);
    if (key === undefined) {
        key = _serializeShaderVertexBuffers(vertexBuffers);
        _vertexBuffersKeys.set(vertexBuffers, key);
    }
    return key;
}
