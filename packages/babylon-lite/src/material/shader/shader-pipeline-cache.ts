import type { EngineContext } from "../../engine/engine.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { ShaderMaterial } from "./shader-material.js";
import type { ShaderPipelineBindings, ShaderPipelineCache } from "./shader-pipeline.js";

interface ShaderModuleEntry {
    readonly id: number;
    readonly module: GPUShaderModule;
}

interface DeviceCache extends ShaderPipelineCache {
    readonly bindings: Map<string, ShaderPipelineBindings>;
    readonly modules: Map<string, ShaderModuleEntry>;
    localGeneration: number;
    nextModuleId: number;
}

interface CacheMaterial extends ShaderMaterial {
    _shaderPipelineCache?: ShaderPipelineCache;
}

let _deviceCaches: WeakMap<GPUDevice, DeviceCache> | null = null;
let _generation = 0;

/** @internal Enable cross-material ShaderMaterial caches for one multi-material build group. */
export function enableShaderPipelineCache(engine: EngineContext, meshes: readonly Pick<Mesh, "material">[]): void {
    const cache = getDeviceCache(engine._device);
    for (const mesh of meshes) {
        (mesh.material as CacheMaterial)._shaderPipelineCache = cache;
    }
}

/** Clear all shared ShaderMaterial layouts, modules, and pipelines. */
export function clearShaderPipelineCache(): void {
    _deviceCaches = null;
    _generation++;
}

function getDeviceCache(device: GPUDevice): DeviceCache {
    _deviceCaches ??= new WeakMap();
    let cache = _deviceCaches.get(device);
    if (cache) {
        return cache;
    }
    const bindings = new Map<string, ShaderPipelineBindings>();
    const modules = new Map<string, ShaderModuleEntry>();
    cache = {
        bindings,
        modules,
        localGeneration: _generation,
        nextModuleId: 1,
        get generation(): number {
            return _generation;
        },
        getBindings(material): ShaderPipelineBindings | undefined {
            refresh(cache!);
            return bindings.get(bindingsKey(material));
        },
        setBindings(material, value): void {
            refresh(cache!);
            bindings.set(bindingsKey(material), value);
        },
        getModule(gpu, code, label): ShaderModuleEntry {
            refresh(cache!);
            let entry = modules.get(code);
            if (!entry) {
                entry = { id: cache!.nextModuleId++, module: gpu.createShaderModule({ label, code }) };
                modules.set(code, entry);
            }
            return entry;
        },
        getPipelineKey(sig, variantKey, vertexModuleId, fragmentModuleId, vertexBuffers, material, stencilKey): string {
            return JSON.stringify([
                targetSignatureKey(sig),
                variantKey,
                vertexModuleId,
                fragmentModuleId,
                vertexBuffers.map((layout) => [
                    layout.arrayStride,
                    layout.stepMode ?? "vertex",
                    Array.from(layout.attributes, (attribute) => [attribute.shaderLocation, attribute.offset, attribute.format]),
                ]),
                material.needAlphaBlending,
                material.blendMode,
                material.depthWrite,
                material.depthCompare,
                material.backFaceCulling,
                material.depthBias,
                material.depthBiasSlopeScale,
                stencilKey,
            ]);
        },
    };
    _deviceCaches.set(device, cache);
    return cache;
}

function refresh(cache: DeviceCache): void {
    if (cache.localGeneration === _generation) {
        return;
    }
    cache.bindings.clear();
    cache.modules.clear();
    cache.localGeneration = _generation;
    cache.nextModuleId = 1;
}

function bindingsKey(material: ShaderMaterial): string {
    return JSON.stringify([
        material.attributes,
        material.uniformDecls.map((decl) => [decl.name, decl.type]),
        material.samplerDecls.map((decl) => [decl.name, decl.sampleType ?? "float", decl.viewDimension ?? "2d", decl.comparison === true]),
        material.storageBufferDecls.map((decl) => [decl.name, decl.type]),
    ]);
}
