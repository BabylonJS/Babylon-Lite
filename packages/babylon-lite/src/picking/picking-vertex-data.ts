import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mesh, MeshVbAttr } from "../mesh/mesh.js";
import { createSingleUniformBGL } from "../shader/bgl-helpers.js";
import type { PickingPipelineSet } from "./picking-pipeline.js";
import { getPickingSceneBGL } from "./picking-pipeline.js";
import { pickingShaderSource, pickingThinInstanceShaderSource } from "./picking-shader.js";
import type { PickDiscardRule, PickVertexDataAttribute } from "./gpu-picker.js";

export interface PickingVertexDataShaderOptions {
    readonly discardWgsl?: string | null;
    readonly worldAdjustWgsl?: string | null;
    readonly storage?: readonly { readonly name: string; readonly type: string }[];
    readonly vertexDataComponents: 0 | 2 | 3 | 4;
}

const PICK_SCENE = /* wgsl */ `
struct SceneUniforms {
viewProjection: mat4x4f,
fragmentCoord: vec2f,
};
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
`;

const DEFAULT_PICK_DISCARD = /* wgsl */ `
fn shouldDiscardPick(input: PickDiscardInput) -> bool {
return false;
}
`;

const DEFAULT_PICK_WORLD_ADJUST = /* wgsl */ `
fn adjustPickWorld(worldPos: vec3f, instanceExtras: vec4f, thinInstanceIndex: u32) -> vec3f {
return worldPos;
}
`;

const PICK_DISCARD_INPUT = /* wgsl */ `
struct PickDiscardInput {
worldPos: vec3f,
fragmentCoord: vec2f,
pickId: u32,
thinInstanceIndex: u32,
hasThinInstance: u32,
instanceExtras: vec4f,
vertexData: vec4f,
};
`;

const PICK_FS = /* wgsl */ `
struct VsOut {
@builtin(position) p: vec4f,
@location(0) @interpolate(flat) pickId: u32,
@location(1) worldPos: vec3f,
@location(2) @interpolate(flat) thinInstanceIndex: u32,
@location(3) @interpolate(flat) hasThinInstance: u32,
@location(4) @interpolate(flat) instanceExtras: vec4f,
@location(5) @interpolate(flat) vertexData: vec4f,
};
struct FsOut { @location(0) color: vec4f, @location(1) depth: vec4f };
@fragment fn fs(input: VsOut) -> FsOut {
if (shouldDiscardPick(PickDiscardInput(input.worldPos, scene.fragmentCoord, input.pickId, input.thinInstanceIndex, input.hasThinInstance, input.instanceExtras, input.vertexData))) { discard; }
let id = input.pickId;
let r = f32((id >> 16u) & 0xFFu) / 255.0;
let g = f32((id >> 8u) & 0xFFu) / 255.0;
let b = f32(id & 0xFFu) / 255.0;
return FsOut(vec4f(r, g, b, 1.0), vec4f(input.p.z, 0.0, 0.0, 0.0));
}
`;

let _cachedDevice: GPUDevice | null = null;
let _meshBGL: GPUBindGroupLayout | null = null;
let _tiMeshBGL: GPUBindGroupLayout | null = null;
let _pipelineSets: Map<string, PickingPipelineSet> | null = null;
let _pipelineVariants: Map<string, GPURenderPipeline> | null = null;
let _thinPipelineVariants: Map<string, GPURenderPipeline> | null = null;

function regularInput(components: 0 | 2 | 3 | 4): string {
    return components === 0 ? "" : `, @location(5) vertexData: vec${components}f`;
}

function regularAssignment(components: 0 | 2 | 3 | 4): string {
    if (components === 2) {
        return "out.vertexData = vec4f(vertexData, 0.0, 0.0);";
    }
    if (components === 3) {
        return "out.vertexData = vec4f(vertexData, 0.0);";
    }
    return components === 4 ? "out.vertexData = vertexData;" : "out.vertexData = vec4f(0.0);";
}

function storageDecls(opts: PickingVertexDataShaderOptions): string {
    const storage = opts.storage;
    return storage?.length ? storage.map((s, binding) => `@group(2) @binding(${binding}) var<storage, read> ${s.name}: ${s.type};`).join("\n") : "";
}

function regularShader(opts: PickingVertexDataShaderOptions): string {
    const components = opts.vertexDataComponents ?? 0;
    return /* wgsl */ `
${PICK_SCENE}
struct MeshUniforms {
world: mat4x4f,
pickId: u32,
};
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
${PICK_DISCARD_INPUT}
${storageDecls(opts)}
${opts.discardWgsl ?? DEFAULT_PICK_DISCARD}
${opts.worldAdjustWgsl ?? DEFAULT_PICK_WORLD_ADJUST}
${PICK_FS}
@vertex fn vs(@location(0) position: vec3f${regularInput(components)}) -> VsOut {
var out: VsOut;
let wp = adjustPickWorld((mesh.world * vec4f(position, 1.0)).xyz, vec4f(0.0), 0xffffffffu);
out.p = scene.viewProjection * vec4f(wp, 1.0);
out.pickId = mesh.pickId;
out.worldPos = wp;
out.thinInstanceIndex = 0xffffffffu;
out.hasThinInstance = 0u;
out.instanceExtras = vec4f(0.0);
${regularAssignment(components)}
return out;
}
`;
}

function thinInstanceShader(opts: PickingVertexDataShaderOptions): string {
    return /* wgsl */ `
${PICK_SCENE}
struct TIMeshUniforms {
baseMeshPickId: u32,
};
@group(1) @binding(0) var<uniform> tiMesh: TIMeshUniforms;
@group(1) @binding(1) var<storage, read> instances: array<mat4x4f>;
${PICK_DISCARD_INPUT}
${storageDecls(opts)}
${opts.discardWgsl ?? DEFAULT_PICK_DISCARD}
${opts.worldAdjustWgsl ?? DEFAULT_PICK_WORLD_ADJUST}
${PICK_FS}
@vertex fn vs(@location(0) position: vec3f, @builtin(instance_index) instanceIndex: u32) -> VsOut {
let m = instances[instanceIndex];
let world = mat4x4f(
vec4f(m[0].xyz, 0.0),
vec4f(m[1].xyz, 0.0),
vec4f(m[2].xyz, 0.0),
vec4f(m[3].xyz, 1.0),
);
let extras = vec4f(m[0].w, m[1].w, m[2].w, m[3].w);
var out: VsOut;
let wp = adjustPickWorld((world * vec4f(position, 1.0)).xyz, extras, instanceIndex);
out.p = scene.viewProjection * vec4f(wp, 1.0);
out.pickId = tiMesh.baseMeshPickId + instanceIndex;
out.worldPos = wp;
out.thinInstanceIndex = instanceIndex;
out.hasThinInstance = 1u;
out.instanceExtras = extras;
out.vertexData = vec4f(0.0);
return out;
}
`;
}

export function pickingVertexDataShaderSource(thinInstance: boolean, opts: PickingVertexDataShaderOptions): string {
    return thinInstance ? thinInstanceShader(opts) : regularShader(opts);
}

export interface PickVertexDataBinding {
    readonly buffer: GPUBuffer;
    readonly interleave?: MeshVbAttr;
}

export function getPickVertexDataBinding(mesh: Mesh, attribute: PickVertexDataAttribute): PickVertexDataBinding | null {
    const gpu = mesh._gpu;
    switch (attribute) {
        case "normal":
            return { buffer: gpu.normalBuffer, interleave: gpu._vbLayout?._n };
        case "uv":
            return gpu.hasUv === false ? null : { buffer: gpu.uvBuffer, interleave: gpu._vbLayout?._u };
        case "uv2":
            return gpu.hasUv2 === false || !gpu.uv2Buffer ? null : { buffer: gpu.uv2Buffer, interleave: gpu._vbLayout?._u2 };
        case "tangent":
            return gpu.hasTangent === false || !gpu.tangentBuffer ? null : { buffer: gpu.tangentBuffer, interleave: gpu._vbLayout?._t };
        case "color":
            return gpu.hasColor === false || !gpu.colorBuffer ? null : { buffer: gpu.colorBuffer, interleave: gpu._vbLayout?._c };
    }
}

interface PickVertexDataLayout {
    readonly components: 2 | 3 | 4;
    readonly offset: number;
    readonly layout: GPUVertexBufferLayout;
}

function positionVertexLayout(interleave?: MeshVbAttr): GPUVertexBufferLayout {
    return {
        arrayStride: interleave?._stride ?? 12,
        attributes: [{ shaderLocation: 0, offset: interleave?._offset ?? 0, format: "float32x3" }],
    };
}

function pickVertexDataLayout(attribute: PickVertexDataAttribute, interleave?: MeshVbAttr): PickVertexDataLayout {
    const components = attribute === "normal" ? 3 : attribute === "uv" || attribute === "uv2" ? 2 : 4;
    const offset = interleave?._offset ?? 0;
    return {
        components,
        offset,
        layout: {
            arrayStride: interleave?._stride ?? components * 4,
            attributes: [{ shaderLocation: 5, offset, format: `float32x${components}` as GPUVertexFormat }],
        },
    };
}

function ensureDevice(engine: EngineContext): void {
    if (_cachedDevice !== engine._device) {
        _cachedDevice = engine._device;
        _meshBGL = null;
        _tiMeshBGL = null;
        _pipelineSets = null;
        _pipelineVariants = null;
        _thinPipelineVariants = null;
    }
}

function getMeshBGL(engine: EngineContext): GPUBindGroupLayout {
    ensureDevice(engine);
    return (_meshBGL ??= createSingleUniformBGL(engine, "picking-mesh-bgl", SS.VERTEX | SS.FRAGMENT));
}

function getTIMeshBGL(engine: EngineContext): GPUBindGroupLayout {
    ensureDevice(engine);
    if (!_tiMeshBGL) {
        _tiMeshBGL = engine._device.createBindGroupLayout({
            label: "picking-ti-mesh-bgl",
            entries: [
                {
                    binding: 0,
                    visibility: SS.VERTEX | SS.FRAGMENT,
                    buffer: { type: "uniform" },
                },
                {
                    binding: 1,
                    visibility: SS.VERTEX,
                    buffer: { type: "read-only-storage" },
                },
            ],
        });
    }
    return _tiMeshBGL;
}

function createDiscardBGL(engine: EngineContext, discard: PickDiscardRule): GPUBindGroupLayout | null {
    if (!discard.storage?.length) {
        return null;
    }
    return engine._device.createBindGroupLayout({
        label: `picking-discard-${discard.key}-bgl`,
        entries: discard.storage.map((_, binding) => ({
            binding,
            visibility: SS.FRAGMENT,
            buffer: { type: "read-only-storage" },
        })),
    });
}

function createPipeline(
    engine: EngineContext,
    shader: string,
    meshBGL: GPUBindGroupLayout,
    discardBGL: GPUBindGroupLayout | null,
    label: string,
    vertexBuffers: readonly GPUVertexBufferLayout[]
): GPURenderPipeline {
    const device = engine._device;
    const module = device.createShaderModule({ label: `${label}-shader`, code: shader });
    const bindGroupLayouts = discardBGL ? [getPickingSceneBGL(engine), meshBGL, discardBGL] : [getPickingSceneBGL(engine), meshBGL];
    const layout = device.createPipelineLayout({ label: `${label}-pipeline-layout`, bindGroupLayouts });
    return device.createRenderPipeline({
        label: `${label}-pipeline`,
        layout,
        vertex: {
            module,
            entryPoint: "vs",
            buffers: vertexBuffers,
        },
        fragment: {
            module,
            entryPoint: "fs",
            targets: [{ format: "rgba8unorm" }, { format: "r32float" }],
        },
        depthStencil: {
            format: "depth24plus",
            depthCompare: "greater",
            depthWriteEnabled: true,
        },
        primitive: {
            topology: "triangle-list",
            cullMode: "none",
        },
        multisample: { count: 1 },
    });
}

/** Get the regular/thin pipeline set for a discard rule that requests vertex data. */
export function getPickingVertexDataPipelineSet(engine: EngineContext, discard: PickDiscardRule): PickingPipelineSet {
    ensureDevice(engine);
    const key = `${discard.key}:${discard.vertexData}`;
    const sets = _pipelineSets ?? (_pipelineSets = new Map());
    const cached = sets.get(key);
    if (cached) {
        return cached;
    }

    const discardBGL = createDiscardBGL(engine, discard);
    const shaderOptions: PickingVertexDataShaderOptions = {
        discardWgsl: discard.wgsl,
        storage: discard.storage,
        vertexDataComponents: 0,
    };
    const regularPipeline = createPipeline(engine, pickingVertexDataShaderSource(false, shaderOptions), getMeshBGL(engine), discardBGL, `picking-${discard.key}`, [
        positionVertexLayout(),
    ]);
    const thinInstancePipeline = createPipeline(engine, pickingVertexDataShaderSource(true, shaderOptions), getTIMeshBGL(engine), discardBGL, `picking-ti-${discard.key}`, [
        positionVertexLayout(),
    ]);
    const set = { regularPipeline, thinInstancePipeline, discardBGL };
    sets.set(key, set);
    return set;
}

/** Resolve a regular-mesh pipeline for tight or interleaved position/optional vertex-data buffers. */
export function getPickingRegularPipeline(
    engine: EngineContext,
    set: PickingPipelineSet,
    discard: PickDiscardRule | null,
    positionInterleave?: MeshVbAttr,
    vertexData?: { readonly attribute: PickVertexDataAttribute; readonly interleave?: MeshVbAttr } | null
): GPURenderPipeline {
    if (!positionInterleave && !vertexData) {
        return set.regularPipeline;
    }

    ensureDevice(engine);
    const dataLayout = vertexData ? pickVertexDataLayout(vertexData.attribute, vertexData.interleave) : null;
    const key = `${discard ? `discard:${discard.key}` : "default"}:p${positionInterleave?._stride ?? 12},${positionInterleave?._offset ?? 0}:d${
        vertexData ? `${vertexData.attribute},${dataLayout!.layout.arrayStride},${dataLayout!.offset}` : "none"
    }`;
    const variants = _pipelineVariants ?? (_pipelineVariants = new Map());
    const cached = variants.get(key);
    if (cached) {
        return cached;
    }

    const shader = discard
        ? discard.vertexData
            ? regularShader({
                  discardWgsl: discard.wgsl,
                  storage: discard.storage,
                  vertexDataComponents: (dataLayout?.components ?? 0) as 0 | 2 | 3 | 4,
              })
            : pickingShaderSource({ discardWgsl: discard.wgsl, storage: discard.storage })
        : pickingShaderSource();
    const label = `${discard ? `picking-${discard.key}` : "picking"}-vb-${positionInterleave?._stride ?? 12}-${positionInterleave?._offset ?? 0}${
        vertexData ? `-${vertexData.attribute}-${dataLayout!.layout.arrayStride}-${dataLayout!.offset}` : ""
    }`;
    const pipeline = createPipeline(
        engine,
        shader,
        set.regularPipeline.getBindGroupLayout(1),
        set.discardBGL,
        label,
        dataLayout ? [positionVertexLayout(positionInterleave), dataLayout.layout] : [positionVertexLayout(positionInterleave)]
    );
    variants.set(key, pipeline);
    return pipeline;
}

/** Resolve a thin-instance pipeline for a tight or interleaved position buffer. */
export function getPickingThinInstancePipeline(
    engine: EngineContext,
    set: PickingPipelineSet,
    discard: PickDiscardRule | null,
    positionInterleave?: MeshVbAttr
): GPURenderPipeline {
    if (!positionInterleave) {
        return set.thinInstancePipeline;
    }

    ensureDevice(engine);
    const key = `${discard ? `discard:${discard.key}` : "default"}:${positionInterleave._stride},${positionInterleave._offset}`;
    const variants = _thinPipelineVariants ?? (_thinPipelineVariants = new Map());
    const cached = variants.get(key);
    if (cached) {
        return cached;
    }

    const shader = discard
        ? discard.vertexData
            ? thinInstanceShader({
                  discardWgsl: discard.wgsl,
                  storage: discard.storage,
                  vertexDataComponents: 0,
              })
            : pickingThinInstanceShaderSource({ discardWgsl: discard.wgsl, storage: discard.storage })
        : pickingThinInstanceShaderSource();
    const label = `${discard ? `picking-ti-${discard.key}` : "picking-ti"}-vb-${positionInterleave._stride}-${positionInterleave._offset}`;
    const pipeline = createPipeline(engine, shader, set.thinInstancePipeline.getBindGroupLayout(1), set.discardBGL, label, [positionVertexLayout(positionInterleave)]);
    variants.set(key, pipeline);
    return pipeline;
}
