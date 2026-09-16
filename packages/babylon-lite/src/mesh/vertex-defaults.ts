import type { EngineContext } from "../engine/engine.js";
import { BU } from "../engine/gpu-flags.js";
import { registerManagedResourceDisposer } from "../resource/managed-resource-hooks.js";
import { _installVertexDefaults } from "./vertex-defaults-hooks.js";
import type { MeshGPU } from "./mesh.js";

interface DefaultBuffer {
    _device: GPUDevice;
    _buffer: GPUBuffer;
}

let buffers: WeakMap<EngineContext, DefaultBuffer> | null = null;

function getDefaultBuffer(engine: EngineContext): GPUBuffer {
    const cache = (buffers ??= new WeakMap());
    let entry = cache.get(engine);
    if (entry?._device === engine._device) {
        return entry._buffer;
    }
    const buffer = engine._device.createBuffer({ label: "mesh-zero-vertex", size: 16, usage: BU.VERTEX | BU.COPY_DST });
    if (entry) {
        entry._buffer.destroy();
        entry._buffer = buffer;
        entry._device = engine._device;
    } else {
        entry = { _device: engine._device, _buffer: buffer };
        cache.set(engine, entry);
        const owned = entry;
        registerManagedResourceDisposer(engine, () => {
            if (cache.get(engine) === owned) {
                cache.delete(engine);
                owned._buffer.destroy();
            }
        });
    }
    return buffer;
}

function missingStream(gpu: MeshGPU, name: string | undefined): boolean {
    return name === "uv2" ? !gpu.uv2Buffer : name === "tangent" ? !gpu.tangentBuffer : name === "color" ? !gpu.colorBuffer : false;
}

/** @internal Constant zero defaults consume no per-vertex or per-slab-slot allocation. */
export function _enableVertexDefaults(): void {
    _installVertexDefaults({
        _buffer: (engine, gpu) => (gpu._vertexCount === undefined ? null : getDefaultBuffer(engine)),
        _layouts: (layouts, names, gpu) =>
            gpu._vertexCount === undefined
                ? layouts
                : layouts.map((layout, index) =>
                      layout.stepMode !== "instance" && missingStream(gpu, names[index])
                          ? {
                                ...layout,
                                arrayStride: 0,
                                attributes: layout.attributes.map((attribute) => ({ ...attribute, offset: 0 })),
                            }
                          : layout
                  ),
    });
}
