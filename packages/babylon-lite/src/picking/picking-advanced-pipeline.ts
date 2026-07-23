/** Pipeline/layout owner for advanced GPU mesh-picking variants. */
import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mesh, MeshVbAttr } from "../mesh/mesh.js";
import { createSingleUniformBGL } from "../shader/bgl-helpers.js";
import type { PickDiscardRule, PickVertexDataAttribute } from "./gpu-picker.js";
import { pickingShaderVariantSource } from "./picking-advanced-shader.js";
import type { PickingVertexProjectionShader } from "./picking-advanced-shader.js";
import { getPickingSceneBGL } from "./picking-scene-bgl.js";

export type PickingDiscardPipelineOptions = PickDiscardRule;

export interface PickingPipelineSet {
    readonly regularPipeline: GPURenderPipeline;
    readonly thinInstancePipeline: GPURenderPipeline;
    readonly discardBGL: GPUBindGroupLayout | null;
    readonly detailed: boolean;
    /** @internal */
    readonly _vertexProjection: PickingVertexProjection | null;
}

/** @internal Lazily supplied material vertex projection for the unified mesh-pick pass. */
export interface PickingVertexProjection {
    readonly key: string;
    readonly shader: PickingVertexProjectionShader;
    readonly vertexBuffers: readonly GPUVertexBufferLayout[];
    readonly regularBGL: GPUBindGroupLayout;
    readonly thinBGL: GPUBindGroupLayout;
}

export interface PickVertexDataBinding {
    readonly buffer: GPUBuffer;
    readonly interleave?: MeshVbAttr;
}

let _cachedDevice: GPUDevice | null = null;
let _meshBGL: GPUBindGroupLayout | null = null;
let _tiMeshBGL: GPUBindGroupLayout | null = null;
let _emptyBGL: GPUBindGroupLayout | null = null;
let _pipelineSets: Map<string, PickingPipelineSet> | null = null;
let _regularVariants: Map<string, GPURenderPipeline> | null = null;
let _thinVariants: Map<string, GPURenderPipeline> | null = null;

function invalidateIfNeeded(engine: EngineContext): void {
    if (_cachedDevice === engine._device) {
        return;
    }
    _cachedDevice = engine._device;
    _meshBGL = null;
    _tiMeshBGL = null;
    _emptyBGL = null;
    _pipelineSets = null;
    _regularVariants = null;
    _thinVariants = null;
}

function getEmptyBGL(engine: EngineContext): GPUBindGroupLayout {
    invalidateIfNeeded(engine);
    return (_emptyBGL ??= engine._device.createBindGroupLayout({ label: "picking-empty-bgl", entries: [] }));
}

function getPickingMeshBGL(engine: EngineContext): GPUBindGroupLayout {
    invalidateIfNeeded(engine);
    return (_meshBGL ??= createSingleUniformBGL(engine, "picking-mesh-bgl", SS.VERTEX | SS.FRAGMENT));
}

function getPickingTIMeshBGL(engine: EngineContext): GPUBindGroupLayout {
    invalidateIfNeeded(engine);
    if (!_tiMeshBGL) {
        _tiMeshBGL = engine._device.createBindGroupLayout({
            label: "picking-ti-mesh-bgl",
            entries: [
                { binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: SS.VERTEX, buffer: { type: "read-only-storage" } },
            ],
        });
    }
    return _tiMeshBGL;
}

function createDiscardBGL(engine: EngineContext, rule: PickDiscardRule): GPUBindGroupLayout | null {
    if (!rule.storage?.length) {
        return null;
    }
    return engine._device.createBindGroupLayout({
        label: `picking-discard-${rule.key}-bgl`,
        entries: rule.storage.map((storage, binding) => ({
            binding,
            visibility: SS.FRAGMENT | (storage.vertex ? SS.VERTEX : 0),
            buffer: { type: "read-only-storage" },
        })),
    });
}

function ruleKey(rule: PickDiscardRule | null | undefined): string {
    if (!rule) {
        return "default";
    }
    const stages = rule.storage?.map((storage) => (storage.vertex ? "v" : "f")).join("") ?? "none";
    return `rule:${rule.key}:${rule.vertexData ?? "none"}:${rule.worldAdjustWgsl ? "adjust" : "identity"}:${stages}`;
}

function positionLayout(interleave?: MeshVbAttr): GPUVertexBufferLayout {
    return {
        arrayStride: interleave?._stride ?? 12,
        attributes: [{ shaderLocation: 0, offset: interleave?._offset ?? 0, format: "float32x3" }],
    };
}

function vertexDataLayout(attribute: PickVertexDataAttribute, interleave?: MeshVbAttr): { components: 2 | 3 | 4; layout: GPUVertexBufferLayout } {
    const components = attribute === "normal" ? 3 : attribute === "uv" || attribute === "uv2" ? 2 : 4;
    return {
        components,
        layout: {
            arrayStride: interleave?._stride ?? components * 4,
            attributes: [{ shaderLocation: 5, offset: interleave?._offset ?? 0, format: `float32x${components}` as GPUVertexFormat }],
        },
    };
}

function createPipeline(
    engine: EngineContext,
    thinInstance: boolean,
    rule: PickDiscardRule | null,
    discardBGL: GPUBindGroupLayout | null,
    label: string,
    vertexBuffers: readonly GPUVertexBufferLayout[],
    vertexDataComponents: 0 | 2 | 3 | 4,
    detailed: boolean,
    vertexProjection: PickingVertexProjection | null
): GPURenderPipeline {
    const module = engine._device.createShaderModule({
        label: `${label}-shader`,
        code: pickingShaderVariantSource(thinInstance, {
            discardWgsl: rule?.wgsl,
            worldAdjustWgsl: rule?.worldAdjustWgsl,
            storage: rule?.storage,
            vertexDataComponents,
            exposeVertexData: !!rule?.vertexData,
            detailed,
            _vertexProjection: vertexProjection?.shader,
        }),
    });
    const meshBGL = thinInstance ? getPickingTIMeshBGL(engine) : getPickingMeshBGL(engine);
    const bindGroupLayouts = vertexProjection
        ? [getPickingSceneBGL(engine), meshBGL, discardBGL ?? getEmptyBGL(engine), thinInstance ? vertexProjection.thinBGL : vertexProjection.regularBGL]
        : discardBGL
          ? [getPickingSceneBGL(engine), meshBGL, discardBGL]
          : [getPickingSceneBGL(engine), meshBGL];
    const layout = engine._device.createPipelineLayout({ label: `${label}-pipeline-layout`, bindGroupLayouts });
    return engine._device.createRenderPipeline({
        label: `${label}-pipeline`,
        layout,
        vertex: { module, entryPoint: "vs", buffers: vertexBuffers as GPUVertexBufferLayout[] },
        fragment: {
            module,
            entryPoint: "fs",
            targets: detailed ? [{ format: "rgba8unorm" }, { format: "r32float" }, { format: "rgba32uint" }] : [{ format: "rgba8unorm" }, { format: "r32float" }],
        },
        depthStencil: { format: "depth24plus", depthCompare: "greater", depthWriteEnabled: true },
        primitive: { topology: "triangle-list", cullMode: "none" },
        multisample: { count: 1 },
    });
}

/** Base tight-buffer pipelines for the supplied rule. All specialized variants derive from this same owner. */
export function getPickingPipelineSet(
    engine: EngineContext,
    rule?: PickDiscardRule | null,
    detailed = false,
    vertexProjection: PickingVertexProjection | null = null
): PickingPipelineSet {
    invalidateIfNeeded(engine);
    const exactDetailed = detailed && engine._device.features.has("primitive-index");
    const key = `${ruleKey(rule)}:${exactDetailed ? "detailed" : "basic"}:${vertexProjection?.key ?? "affine"}`;
    const sets = (_pipelineSets ??= new Map());
    const cached = sets.get(key);
    if (cached) {
        return cached;
    }
    const activeRule = rule ?? null;
    const discardBGL = activeRule ? createDiscardBGL(engine, activeRule) : null;
    const set: PickingPipelineSet = {
        regularPipeline: createPipeline(
            engine,
            false,
            activeRule,
            discardBGL,
            activeRule ? `picking-${activeRule.key}-${vertexProjection?.key ?? "affine"}` : `picking-${vertexProjection?.key ?? "affine"}`,
            [positionLayout(), ...(vertexProjection?.vertexBuffers ?? [])],
            0,
            exactDetailed,
            vertexProjection
        ),
        thinInstancePipeline: createPipeline(
            engine,
            true,
            activeRule,
            discardBGL,
            activeRule ? `picking-ti-${activeRule.key}-${vertexProjection?.key ?? "affine"}` : `picking-ti-${vertexProjection?.key ?? "affine"}`,
            [positionLayout(), ...(vertexProjection?.vertexBuffers ?? [])],
            0,
            exactDetailed,
            vertexProjection
        ),
        discardBGL,
        detailed: exactDetailed,
        _vertexProjection: vertexProjection,
    };
    sets.set(key, set);
    return set;
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

export function getPickingRegularPipeline(
    engine: EngineContext,
    set: PickingPipelineSet,
    rule: PickDiscardRule | null,
    positionInterleave?: MeshVbAttr,
    vertexData?: { readonly attribute: PickVertexDataAttribute; readonly interleave?: MeshVbAttr } | null
): GPURenderPipeline {
    if (!positionInterleave && !vertexData) {
        return set.regularPipeline;
    }
    invalidateIfNeeded(engine);
    const data = vertexData ? vertexDataLayout(vertexData.attribute, vertexData.interleave) : null;
    const key = `${ruleKey(rule)}:${set.detailed ? "detailed" : "basic"}:${set._vertexProjection?.key ?? "affine"}:p${positionInterleave?._stride ?? 12},${positionInterleave?._offset ?? 0}:d${
        vertexData ? `${vertexData.attribute},${data!.layout.arrayStride},${vertexData.interleave?._offset ?? 0}` : "none"
    }`;
    const variants = (_regularVariants ??= new Map());
    const cached = variants.get(key);
    if (cached) {
        return cached;
    }
    const label = `picking-vb-${key}`;
    const pipeline = createPipeline(
        engine,
        false,
        rule,
        set.discardBGL,
        label,
        data
            ? [positionLayout(positionInterleave), data.layout, ...(set._vertexProjection?.vertexBuffers ?? [])]
            : [positionLayout(positionInterleave), ...(set._vertexProjection?.vertexBuffers ?? [])],
        data?.components ?? 0,
        set.detailed,
        set._vertexProjection
    );
    variants.set(key, pipeline);
    return pipeline;
}

export function getPickingThinInstancePipeline(engine: EngineContext, set: PickingPipelineSet, rule: PickDiscardRule | null, positionInterleave?: MeshVbAttr): GPURenderPipeline {
    if (!positionInterleave) {
        return set.thinInstancePipeline;
    }
    invalidateIfNeeded(engine);
    const key = `${ruleKey(rule)}:${set.detailed ? "detailed" : "basic"}:${set._vertexProjection?.key ?? "affine"}:p${positionInterleave._stride},${positionInterleave._offset}`;
    const variants = (_thinVariants ??= new Map());
    const cached = variants.get(key);
    if (cached) {
        return cached;
    }
    const pipeline = createPipeline(
        engine,
        true,
        rule,
        set.discardBGL,
        `picking-ti-vb-${key}`,
        [positionLayout(positionInterleave), ...(set._vertexProjection?.vertexBuffers ?? [])],
        0,
        set.detailed,
        set._vertexProjection
    );
    variants.set(key, pipeline);
    return pipeline;
}
