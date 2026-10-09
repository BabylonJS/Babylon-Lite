import type { EngineContext } from "../../engine/engine.js";
import { targetSignatureKey } from "../../engine/render-target-signature.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { ShaderMaterial } from "./shader-material.js";
import type { ShaderPipelineBindings, ShaderPipelineCache } from "./shader-pipeline.js";
import { _getShaderVbSupport } from "./shader-vb-support.js";

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

let _deviceCaches: WeakMap<GPUDevice, DeviceCache> | null = null;
let _generation = 0;
let _vertexBuffersKey: ((layouts: readonly GPUVertexBufferLayout[]) => string) | null = null;

/** @internal Install the optional vertex-layout key resolver. */
export function _setShaderVertexBuffersKey(resolve: ((layouts: readonly GPUVertexBufferLayout[]) => string) | null): void {
    _vertexBuffersKey = resolve;
}

/** @internal Enable cross-material ShaderMaterial caches for one multi-material build group. */
export function enableShaderPipelineCache(engine: EngineContext, meshes: readonly Pick<Mesh, "material">[]): void {
    const cache = _getShaderDeviceCache(engine._device);
    for (const mesh of meshes) {
        (mesh.material as ShaderMaterial)._shaderPipelineCache = cache;
    }
}

/** Clear all shared ShaderMaterial layouts, modules, and pipelines. */
export function clearShaderPipelineCache(): void {
    _deviceCaches = null;
    _generation++;
}

/** @internal Move an installed cross-material cache to the current GPU device before async preparation. */
export function retargetShaderPipelineCache(material: ShaderMaterial, device: GPUDevice): void {
    if (material._shaderPipelineCache) {
        material._shaderPipelineCache = _getShaderDeviceCache(device);
    }
}

/** @internal Resolve the shared cache for the current real GPU device. */
export function _getShaderDeviceCache(device: GPUDevice): ShaderPipelineCache {
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
        _getModules(gpu, material, currentBindings, key, label, createCodes) {
            let memo = material._shaderModuleMemo;
            if (!memo || memo[0] !== material || memo[1] !== currentBindings) {
                material._shaderModuleMemo = memo = [material, currentBindings, new Map()];
            }
            let resolved = memo[2].get(key);
            if (!resolved) {
                const [vertexCode, fragmentCode] = createCodes();
                const vert = cache!.getModule(gpu, vertexCode, `${label}-vertex`);
                const frag = fragmentCode === null ? null : cache!.getModule(gpu, fragmentCode, `${label}-fragment`);
                resolved = [vert, frag];
                memo[2].set(key, resolved);
            }
            return resolved;
        },
        getPipelineKey(sig, variantKey, vertexModuleId, fragmentModuleId, vertexBuffers, material, stencilKey): string {
            return JSON.stringify([
                targetSignatureKey(sig),
                variantKey,
                vertexModuleId,
                fragmentModuleId,
                _vertexBuffersKey?.(vertexBuffers) ?? _serializeShaderVertexBuffers(vertexBuffers),
                material.needAlphaBlending,
                material.blendMode,
                // The explicit blend override participates in the cross-material key: two materials
                // sharing modules but differing only by `blend` must not collide on one pipeline.
                material.blend ?? null,
                material.depthWrite,
                material.depthCompare,
                material.backFaceCulling,
                material.depthBias,
                material.depthBiasSlopeScale,
                material._topology,
                stencilKey,
            ]);
        },
    };
    _deviceCaches.set(device, cache);
    return cache;
}

/** @internal Canonical vertex-layout representation, unchanged by global sharing enablement. */
export function _serializeShaderVertexBuffers(vertexBuffers: readonly GPUVertexBufferLayout[]): string {
    return JSON.stringify(
        vertexBuffers.map((layout) => [
            layout.arrayStride,
            layout.stepMode ?? "vertex",
            Array.from(layout.attributes, (attribute) => [attribute.shaderLocation, attribute.offset, attribute.format]),
        ])
    );
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
        _getShaderVbSupport()?._layouts(material) ?? null,
        material.uniformDecls.map((decl) => [decl.name, decl.type]),
        material.samplerDecls.map((decl) => [decl.name, decl.sampleType ?? "float", decl.viewDimension ?? "2d", decl.comparison === true]),
        material._externalTextureDecls ?? null,
        material.storageBufferDecls.map((decl) => [decl.name, decl.type]),
    ]);
}
