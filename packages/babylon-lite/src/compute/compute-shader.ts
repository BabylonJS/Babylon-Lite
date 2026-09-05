/*
 * Module: compute-shader
 *
 * A user-facing compute seam. Lite already runs compute internally (mipmap
 * generation, BRDF decode, thin-instance culling, HDR/IBL), but never exposed a
 * way for callers to run their own, so GPU-generated data, and GPU-generated
 * geometry in particular, had no supported path.
 *
 * Shape follows `createShaderMaterial`: the caller supplies WGSL plus declared
 * uniforms and storage bindings, and the object owns its bind-group layout,
 * pipeline, and uniform buffer. Nothing here leaks a raw WebGPU handle, since
 * storage is bound as an opaque `StorageBuffer`, so the "no GPU internals in the
 * public API" pillar holds.
 *
 * Dispatches are recorded through `compute-pass`, the same helper the engine's
 * own thin-instance culling records through — one dispatch path, not two.
 *
 * Zero cost when unused: no core render path imports this module.
 *
 * ── Running one program over many data sets ─────────────────────────────────
 *
 * Re-set between dispatches. Each `dispatchCompute` is its own submission, so
 * both uniforms and storage bindings take effect per dispatch:
 *
 *     for (const chunk of chunks) {
 *         setComputeUniform(filler, "span", chunk.span);
 *         setComputeStorageBuffer(filler, "params", chunk.params);
 *         dispatchCompute(engine, filler, chunk.groups);
 *     }
 *
 * That this works at all is a consequence of dispatching one submission at a
 * time. `queue.writeBuffer` is ordered against SUBMISSION, not recording, so the
 * moment several dispatches are batched into one command buffer they all observe
 * the LAST uniform value written, and a set of differently-parameterised
 * dispatches silently collapses into N copies of the final one. We hit exactly
 * that while prototyping. Any future batching API has to solve it — which is why
 * batching is deliberately not part of this first surface.
 *
 * For a large uniform work set, prefer ONE dispatch that indexes per-item
 * parameters out of a storage buffer by invocation id:
 *
 *     struct ChunkParams { slotBase: u32, u0: f32, v0: f32, span: f32 };
 *     @group(0) @binding(1) var<storage, read> params: array<ChunkParams>;
 *     let p = params[gid.x / vertsPerChunk];
 *
 * It scales past `maxUniformBufferBindingSize`, keeps occupancy high, and costs
 * one submission rather than N.
 *
 * Ordering: WebGPU queue submission is ordered, so a dispatch submitted before a
 * frame's draws is visible to those draws.
 */
import type { EngineContext } from "../engine/engine.js";
import { computeUboLayout } from "../shader/ubo-layout.js";
import type { UboSpec } from "../shader/fragment-types.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { _getStorageBufferHandle, type StorageBuffer } from "../resource/storage-buffer.js";
import { recordComputeDispatches } from "./compute-pass.js";
import type { ShaderDefineMap, ShaderUniformType, ShaderUniformValue } from "../material/shader/shader-material.js";

/** A uniform constant across the dispatch. Per-item data belongs in a storage buffer. */
export interface ComputeUniformDecl {
    readonly name: string;
    readonly type: ShaderUniformType;
    readonly defaultValue?: ShaderUniformValue;
}

/** A storage binding. `type` is the WGSL variable type, e.g. `array<vec4<f32>>`. */
export interface ComputeStorageBufferDecl {
    readonly name: string;
    readonly type: string;
    /** Bind as `var<storage, read_write>`. The bound allocation must be `writable: true`. */
    readonly writable?: boolean;
}

/** Options for {@link createComputeShader}. */
export interface ComputeShaderOptions {
    readonly name?: string;
    /** WGSL body. Uniform and storage declarations are generated and prepended. */
    readonly computeSource: string;
    /** Entry point name. Default `"main"`. */
    readonly entryPoint?: string;
    readonly uniforms?: readonly ComputeUniformDecl[];
    readonly storageBuffers?: readonly ComputeStorageBufferDecl[];
    readonly defines?: ShaderDefineMap;
}

declare const computeShaderBrand: unique symbol;

/** A compute program with its own bindings. Create with {@link createComputeShader}. */
export interface ComputeShader {
    readonly [computeShaderBrand]: true;
    readonly name: string;
    /** @internal */ readonly _engine: EngineContext;
    /** @internal */ readonly _entryPoint: string;
    /** @internal */ readonly _wgsl: string;
    /** @internal */ readonly _uniformDecls: readonly ComputeUniformDecl[];
    /** @internal */ readonly _storageDecls: readonly ComputeStorageBufferDecl[];
    /** @internal */ readonly _uboSpec: UboSpec | null;
    /** @internal */ _uboData: ArrayBuffer | null;
    /** @internal */ _uboBuffer: GPUBuffer | null;
    /** @internal */ _uboDirty: boolean;
    /** @internal */ _bindings: Map<string, StorageBuffer>;
    /** @internal */ _layout: GPUBindGroupLayout | null;
    /** @internal */ _pipeline: GPUComputePipeline | null;
    /** @internal */ _bindGroup: GPUBindGroup | null;
    /** @internal */ _bindGroupDirty: boolean;
    /** @internal The GPUBuffers `_bindGroup` was built from, in binding order. A bound
     *  allocation can be rebuilt or disposed without the device changing, which leaves the
     *  cached group holding a handle nothing owns any more. */
    _bindGroupHandles: (GPUBuffer | null)[] | null;
    /** @internal */ _destroyed: boolean;
    /** @internal Device every cached GPU object below belongs to. Compared on each use so
     *  a device-loss replacement invalidates them — GUIDANCE.md's cache rule. */
    _device: GPUDevice | null;
}

function assertIdentifier(kind: string, name: string): void {
    if (!/^[A-Za-z_]\w*$/.test(name)) {
        throw new Error(`ComputeShader: ${kind} name "${name}" is not a valid WGSL identifier.`);
    }
}

function formatF32(value: number): string {
    return Number.isInteger(value) ? `${value}.0` : String(value);
}

function buildPrelude(options: ComputeShaderOptions, uboSpec: UboSpec | null): string {
    let wgsl = "";
    for (const [name, value] of Object.entries(options.defines ?? {})) {
        assertIdentifier("define", name);
        wgsl += `const ${name}: ${typeof value === "boolean" ? "bool" : "f32"} = ${typeof value === "boolean" ? String(value) : formatF32(value)};\n`;
    }
    let binding = 0;
    if (uboSpec) {
        wgsl += `struct ComputeUniforms {\n${uboSpec._structBody}\n}\n@group(0) @binding(${binding++}) var<uniform> uniforms: ComputeUniforms;\n`;
    }
    for (const storage of options.storageBuffers ?? []) {
        assertIdentifier("storage buffer", storage.name);
        wgsl += `@group(0) @binding(${binding++}) var<storage, ${storage.writable ? "read_write" : "read"}> ${storage.name}: ${storage.type};\n`;
    }
    return wgsl;
}

/** Create a compute program. WGSL declarations for uniforms and storage are generated. */
export function createComputeShader(engine: EngineContext, options: ComputeShaderOptions): ComputeShader {
    const uniformDecls = options.uniforms ?? [];
    for (const u of uniformDecls) {
        assertIdentifier("uniform", u.name);
    }
    const uboSpec = uniformDecls.length > 0 ? computeUboLayout(uniformDecls.map((u) => ({ _name: u.name, _type: u.type }))) : null;

    const shader = {
        name: options.name ?? "compute",
        _engine: engine,
        _entryPoint: options.entryPoint ?? "main",
        _wgsl: buildPrelude(options, uboSpec) + options.computeSource,
        _uniformDecls: uniformDecls,
        _storageDecls: options.storageBuffers ?? [],
        _uboSpec: uboSpec,
        _uboData: uboSpec ? new ArrayBuffer(uboSpec._totalBytes) : null,
        _uboBuffer: uboSpec ? createEmptyUniformBuffer(engine, uboSpec._totalBytes, `${options.name ?? "compute"}-ubo`) : null,
        // Nothing to flush when no uniforms were declared, so it must not read as pending.
        _uboDirty: uboSpec !== null,
        _bindings: new Map<string, StorageBuffer>(),
        _layout: null,
        _pipeline: null,
        _bindGroup: null,
        _bindGroupDirty: true,
        _destroyed: false,
        _device: engine._device,
    } as unknown as ComputeShader;

    for (const u of uniformDecls) {
        if (u.defaultValue !== undefined) {
            setComputeUniform(shader, u.name, u.defaultValue);
        }
    }
    return shader;
}

/** Drop every device-scoped object when the engine's device has been replaced.
 *
 *  A compute program caches a bind-group layout, a pipeline, a bind group and a uniform
 *  buffer, all created against one `GPUDevice`. After device-lost recovery installs a
 *  replacement, every one of them belongs to the dead device and using any of them is an
 *  error. The uniform DATA survives — it lives in a CPU `ArrayBuffer` — so the buffer is
 *  reallocated and marked dirty, and the next dispatch re-uploads the values the caller
 *  already set rather than losing them. Storage bindings are re-read through
 *  `_getStorageBufferHandle`, which resolves each allocation's rebuilt buffer. */
function refreshForDevice(shader: ComputeShader): void {
    const device = shader._engine._device;
    if (shader._device === device) {
        return;
    }
    shader._device = device;
    shader._layout = null;
    shader._pipeline = null;
    shader._bindGroup = null;
    shader._bindGroupHandles = null;
    shader._bindGroupDirty = true;
    if (shader._uboSpec && shader._uboData) {
        // The previous buffer died with its device; there is nothing to destroy.
        shader._uboBuffer = createEmptyUniformBuffer(shader._engine, shader._uboSpec._totalBytes, `${shader.name}-ubo`);
        shader._uboDirty = true;
    }
}

function bindGroupLayout(shader: ComputeShader): GPUBindGroupLayout {
    if (shader._layout) {
        return shader._layout;
    }
    const entries: GPUBindGroupLayoutEntry[] = [];
    let binding = 0;
    const COMPUTE = globalThis.GPUShaderStage.COMPUTE;
    if (shader._uboSpec) {
        entries.push({ binding: binding++, visibility: COMPUTE, buffer: { type: "uniform" } });
    }
    for (const decl of shader._storageDecls) {
        entries.push({ binding: binding++, visibility: COMPUTE, buffer: { type: decl.writable ? "storage" : "read-only-storage" } });
    }
    shader._layout = shader._engine._device.createBindGroupLayout({ label: `${shader.name}-layout`, entries });
    return shader._layout;
}

function pipelineDescriptor(shader: ComputeShader): GPUComputePipelineDescriptor {
    const device = shader._engine._device;
    const module = device.createShaderModule({ code: shader._wgsl, label: `${shader.name}-module` });
    return {
        label: shader.name,
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout(shader)] }),
        compute: { module, entryPoint: shader._entryPoint },
    };
}

function ensurePipeline(shader: ComputeShader): GPUComputePipeline {
    shader._pipeline ??= shader._engine._device.createComputePipeline(pipelineDescriptor(shader));
    return shader._pipeline;
}

/**
 * Compile the pipeline off the critical path.
 *
 * `dispatchCompute` compiles synchronously on first use, which stalls the frame
 * it happens on. Awaiting this beforehand moves that cost elsewhere.
 */
export async function prepareComputeShader(shader: ComputeShader): Promise<void> {
    if (shader._destroyed) {
        return;
    }
    refreshForDevice(shader);
    if (shader._pipeline) {
        return;
    }
    // Capture the device and re-check after the await. A device loss during compilation
    // would otherwise land a pipeline built against the DEAD device -- and land it after
    // `refreshForDevice` has already recorded the new one, so the staleness latches and no
    // later dispatch can detect it. Disposal during the await is the same hazard.
    const device = shader._engine._device;
    const pipeline = await device.createComputePipelineAsync(pipelineDescriptor(shader));
    if (shader._destroyed || shader._engine._device !== device) {
        return;
    }
    shader._pipeline = pipeline;
}

/**
 * Set a declared uniform. Takes effect from the next `dispatchCompute`, which is
 * its own submission — see the module header on why batching would break that.
 */
export function setComputeUniform(shader: ComputeShader, name: string, value: ShaderUniformValue): void {
    const spec = shader._uboSpec;
    if (!spec || !shader._uboData) {
        throw new Error(`ComputeShader "${shader.name}": no uniforms were declared.`);
    }
    const offset = spec._offsets.get(name);
    if (offset === undefined) {
        throw new Error(`ComputeShader "${shader.name}": uniform "${name}" was not declared.`);
    }
    const decl = shader._uniformDecls.find((u) => u.name === name)!;
    const view = new DataView(shader._uboData);
    const nums = typeof value === "number" ? [value] : Array.from(value as ArrayLike<number>);
    for (let i = 0; i < nums.length; i++) {
        const at = offset + i * 4;
        if (at + 4 > shader._uboData.byteLength) {
            break;
        }
        if (decl.type === "u32") {
            view.setUint32(at, nums[i]!, true);
        } else if (decl.type === "i32") {
            view.setInt32(at, nums[i]!, true);
        } else {
            view.setFloat32(at, nums[i]!, true);
        }
    }
    shader._uboDirty = true;
}

/** Bind a storage allocation to a declared storage binding. Takes effect from the
 *  next `dispatchCompute`. */
export function setComputeStorageBuffer(shader: ComputeShader, name: string, buffer: StorageBuffer): void {
    const decl = shader._storageDecls.find((d) => d.name === name);
    if (!decl) {
        throw new Error(`ComputeShader "${shader.name}": storage buffer "${name}" was not declared.`);
    }
    if (decl.writable && !buffer._writable) {
        throw new Error(`ComputeShader "${shader.name}": binding "${name}" is read_write, so its StorageBuffer must be created with { writable: true }.`);
    }
    shader._bindings.set(name, buffer);
    shader._bindGroupDirty = true;
}

/** True when every buffer the cached group was built from is still the one its allocation
 *  holds. Compares handles rather than a generation counter so nothing extra has to be
 *  maintained on `StorageBuffer`, and reads `_buffer` directly rather than resolving it,
 *  because resolving a disposed allocation throws and this is only a staleness question. */
function bindGroupHandlesCurrent(shader: ComputeShader): boolean {
    const recorded = shader._bindGroupHandles;
    if (!recorded) {
        return false;
    }
    let i = 0;
    if (shader._uboSpec && recorded[i++] !== shader._uboBuffer) {
        return false;
    }
    for (const decl of shader._storageDecls) {
        if (recorded[i++] !== (shader._bindings.get(decl.name)?._buffer ?? null)) {
            return false;
        }
    }
    return true;
}

function ensureBindGroup(shader: ComputeShader): GPUBindGroup {
    if (shader._bindGroup && !shader._bindGroupDirty && bindGroupHandlesCurrent(shader)) {
        return shader._bindGroup;
    }
    const handles: (GPUBuffer | null)[] = [];
    const entries: GPUBindGroupEntry[] = [];
    let binding = 0;
    if (shader._uboBuffer) {
        entries.push({ binding: binding++, resource: { buffer: shader._uboBuffer } });
    }
    if (shader._uboSpec) {
        handles.push(shader._uboBuffer);
    }
    for (const decl of shader._storageDecls) {
        const bound = shader._bindings.get(decl.name);
        if (!bound) {
            throw new Error(`ComputeShader "${shader.name}": storage buffer "${decl.name}" was declared but never bound.`);
        }
        const handle = _getStorageBufferHandle(shader._engine, bound);
        handles.push(handle);
        entries.push({ binding: binding++, resource: { buffer: handle } });
    }
    shader._bindGroup = shader._engine._device.createBindGroup({ label: `${shader.name}-bindgroup`, layout: bindGroupLayout(shader), entries });
    shader._bindGroupHandles = handles;
    shader._bindGroupDirty = false;
    return shader._bindGroup;
}

/**
 * Run the compute program over `x` by `y` by `z` workgroups, and submit it.
 *
 * Opens its own encoder and submits, the same way the loaders, the IBL/BRDF
 * preprocessors and the GPU picker already do. Recording into the frame's own
 * encoder instead would fold N dispatches into one submission, but it needs
 * `renderFrame` to publish whether a frame is recording, and that costs bytes in
 * every scene — including scenes that never dispatch. See the PR discussion.
 */
export function dispatchCompute(engine: EngineContext, shader: ComputeShader, x: number, y = 1, z = 1): void {
    if (shader._destroyed) {
        throw new Error(`ComputeShader "${shader.name}" has been disposed.`);
    }
    if (shader._engine !== engine) {
        throw new Error(`ComputeShader "${shader.name}" belongs to a different engine.`);
    }
    if (!(x > 0 && y > 0 && z > 0)) {
        throw new Error(`ComputeShader "${shader.name}": workgroup counts must all be positive.`);
    }

    refreshForDevice(shader);
    const device = engine._device;
    if (shader._uboDirty && shader._uboBuffer && shader._uboData) {
        device.queue.writeBuffer(shader._uboBuffer, 0, shader._uboData);
        shader._uboDirty = false;
    }

    const dispatch = { _pipeline: ensurePipeline(shader), _bindGroup: ensureBindGroup(shader), _x: x, _y: y, _z: z };
    const encoder = device.createCommandEncoder({ label: `${shader.name}-encoder` });
    recordComputeDispatches(encoder, [dispatch], 1);
    device.queue.submit([encoder.finish()]);
}

/** Release the program's GPU objects. Bound storage buffers are not owned or freed. */
export function disposeComputeShader(shader: ComputeShader): void {
    if (shader._destroyed) {
        return;
    }
    shader._uboBuffer?.destroy();
    shader._uboBuffer = null;
    shader._uboData = null;
    shader._pipeline = null;
    shader._bindGroup = null;
    shader._layout = null;
    shader._bindings.clear();
    shader._device = null;
    shader._destroyed = true;
}
