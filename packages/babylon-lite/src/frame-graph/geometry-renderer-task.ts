/**
 * GeometryRendererTask — frame-graph task that renders a list of meshes into
 * a multi-render-target (MRT) bundle of geometry textures (depth, normal,
 * reflectivity, velocity, …).
 *
 * Modelled on Babylon.js' `FrameGraphGeometryRendererTask`. Phase 1 supports
 * Standard materials only; meshes whose material family is not "standard" are
 * silently skipped.
 *
 * Architecture — MaterialView reuse of the standard renderable pipeline,
 * per directive: "we must use a material view, to make sure we reuse the
 * exact same shader code than the original material, but we inject some
 * shader code at the end of the fragment to output the data for the
 * geometry textures!"
 *
 * Each unique source Standard material is wrapped in a
 * {@link createStandardGeometryMaterialView}; the view's
 * {@link MaterialView._buildRenderable} hook (wired by the view factory)
 * produces a per-mesh {@link Renderable} via the shared
 * {@link buildStandardGeometryRenderable} factory. The Renderable handles
 * its own per-frame work: meshUBO + writeMeshLightSelection, matUBO
 * version refresh, group(1) bind group, vertex/index buffer setup, draw.
 * The task only owns the MRT pass scaffolding (scene UBO + bind group,
 * gp UBO, render-pass descriptor, draw loop) — mirroring how shadow
 * generators dispatch caster meshes through `task.addMesh(mesh, { material: view })`.
 *
 * The task owns its own scene UBO + bind group + per-task gp UBO so
 * existing scenes that never import this module pay zero bytes for it.
 *
 * Per-type accessor wrappers: each `geometryXxxTexture` exposes the MRT's
 * relevant attachment as a regular `RenderTarget` (with its `_colorTexture` /
 * `_colorView` populated post-record), letting downstream tasks (e.g.
 * `createCopyToTextureTask`) consume a single geometry attachment as if it
 * were an ordinary single-attachment render target.
 */

import { F32 } from "../engine/typed-arrays.js";
import type { Camera } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { SurfaceContext } from "../engine/surface.js";
import type { RenderTarget, RenderTargetDescriptor, RenderTargetSignature } from "../engine/render-target.js";
import { buildRenderTarget } from "../engine/render-target.js";
import type { RenderTargetMrt } from "../engine/render-target-mrt.js";
import { buildRenderTargetMrt, createRenderTargetMrt, disposeRenderTargetMrt, getSampledColorTexture, getSampledColorView } from "../engine/render-target-mrt.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Material, MaterialRenderFeatures } from "../material/material.js";
import { getMaterialSource } from "../material/material-view.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import type { StandardGeometryMaterialView, StandardGeometryViewConfig } from "../material/standard/geometry-view.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { PbrGeometryMaterialView, PbrGeometryViewConfig } from "../material/pbr/pbr-geometry-view.js";
import type { NodeMaterial } from "../material/node/node-material.js";
import type { NodeGeometryMaterialView, NodeGeometryViewConfig } from "../material/node/node-geometry-view.js";
import type { DrawBinding, Renderable } from "../render/renderable.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { ensureSceneLightState } from "../render/lights-ubo.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-size.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Task } from "./task.js";
import type { GeometryClearValue } from "./geometry-types.js";
import { GEOMETRY_TEXTURE_DESCRIPTIONS, GeometryTextureType } from "./geometry-types.js";
import { _packSceneUniforms } from "./scene-uniforms-pack.js";

// ─── Public API ────────────────────────────────────────────────────────────

/** One MRT color attachment requested by the user. */
export interface GeometryRendererTextureDescription {
    /** Which geometry value to write. */
    readonly type: GeometryTextureType;
    /** Per-attachment WebGPU format override. Defaults to
     *  `GEOMETRY_TEXTURE_DESCRIPTIONS[type].defaultFormat`. */
    readonly format?: GPUTextureFormat;
    /** Per-attachment clear-value override. Defaults to
     *  `GEOMETRY_TEXTURE_DESCRIPTIONS[type].clearValue`. Use to match a
     *  reference engine's clear behaviour (e.g. clear VIEW_DEPTH to 0 instead of
     *  the camera far plane to mirror BJS's PREPASS_DEPTH). */
    readonly clearValue?: GPUColor;
}

/** Configuration for a geometry-renderer frame-graph task. Describes the meshes, camera, target size, geometry texture attachments, and optional real-color output target used by the MRT pass. */
export interface GeometryRendererTaskConfig {
    name?: string;
    /** Caster meshes. When omitted, defaults to `scene.meshes`. */
    meshes?: readonly Mesh[];
    /** Per-pass camera override. Defaults to `scene.camera`. */
    camera?: Camera | null;
    /** Render-target size. Defaults to the scene's `surface`. */
    size?: SurfaceContext | { width: number; height: number };
    /** MSAA sample count. Defaults to 1. */
    samples?: 1 | 4;
    /** Externally-owned depth attachment. When omitted, the task creates its
     *  own `depth32float` depth texture sized to match the color attachments. */
    depthTexture?: RenderTarget | null;
    /** Ordered list of MRT attachments (1..8). The array index becomes the
     *  fragment shader's `@location(i)` and the render-pass color attachment slot. */
    readonly textureDescriptions: readonly GeometryRendererTextureDescription[];
    /** Flip culling direction. Default false. */
    reverseCulling?: boolean;
    /** Optional color render-target that receives the *real* (lit) material
     *  color, written as an additional color attachment alongside the geometry
     *  data attachments. Must have the same `sampleCount` and resolved
     *  pixel size as the geometry MRT (size: `<surface>` with samples matching).
     *  When omitted, no real-color attachment is added to the pass.
     *
     *  The target attachment uses `loadOp: "load"` (matches BJS), so the
     *  caller must initialize the target's contents (e.g. via a clear pass)
     *  before the geometry task runs — unless {@link targetTextureClearColor}
     *  is provided. */
    targetTexture?: RenderTarget;
    /** When set together with {@link targetTexture}, the target attachment
     *  uses `loadOp: "clear"` with this color at the start of the geometry
     *  pass. Convenient for demo / standalone use where no prior task has
     *  initialized the target's contents. */
    targetTextureClearColor?: GPUColor;
}

export interface GeometryRendererTask extends Task {
    readonly name: string;
    /** The optional target texture the task wrote the real (lit) color into.
     *  Equal to {@link GeometryRendererTaskConfig.targetTexture} when the
     *  config provided one, otherwise `undefined`. */
    readonly outputTexture: RenderTarget | undefined;
    /** Single-attachment depth `RenderTarget` exposing the pass's depth/stencil
     *  attachment. Downstream tasks (e.g. a `RenderTask` running after the
     *  geometry pass) can consume this as a depth input to reuse the values
     *  written here. When the caller supplied an external `depthTexture` in the
     *  config, this returns that same RT; otherwise it wraps the MRT-owned
     *  depth and is populated post-`record()`. */
    readonly geometryDepthTexture: RenderTarget;
    /** Per-type accessors. `null` when that type was not requested. Each value
     *  is a single-attachment `RenderTarget` whose color slot aliases the
     *  matching MRT attachment, so downstream tasks (copy-to-texture, etc.)
     *  can consume it like an ordinary RT. */
    readonly geometryIrradianceTexture: RenderTarget | null;
    readonly geometryWorldPositionTexture: RenderTarget | null;
    readonly geometryLocalPositionTexture: RenderTarget | null;
    readonly geometryReflectivityTexture: RenderTarget | null;
    readonly geometryViewDepthTexture: RenderTarget | null;
    readonly geometryNormalizedViewDepthTexture: RenderTarget | null;
    readonly geometryScreenspaceDepthTexture: RenderTarget | null;
    readonly geometryViewNormalTexture: RenderTarget | null;
    readonly geometryWorldNormalTexture: RenderTarget | null;
    readonly geometryAlbedoTexture: RenderTarget | null;
    readonly geometryLinearVelocityTexture: RenderTarget | null;
    /** Skip a mesh from the velocity attachment's previous-world tracking. */
    excludeFromVelocity(mesh: Mesh): void;
    /** Re-include a mesh in velocity tracking. */
    includeInVelocity(mesh: Mesh): void;
}

// ─── Internal types ────────────────────────────────────────────────────────

interface AttachmentInfo {
    readonly _type: GeometryTextureType;
    readonly _index: number;
    readonly _format: GPUTextureFormat;
    readonly _clearValue: GeometryClearValue;
}

/** One mesh + its bound DrawBinding. The Renderable owns its own per-mesh
 *  GPU state (UBOs, bind group); the binding owns the per-signature pipeline. */
interface BoundMesh {
    readonly _mesh: Mesh;
    readonly _binding: DrawBinding;
    readonly _view: StandardGeometryMaterialView | PbrGeometryMaterialView | NodeGeometryMaterialView;
}

interface GeometryRendererTaskInternal extends GeometryRendererTask {
    /** The MRT render target owning all the geometry-data color attachments
     *  and (when no external depth was supplied) the depth attachment. */
    _mrt: RenderTargetMrt;
    _attachments: AttachmentInfo[];
    /** One view per unique source material (Standard, PBR or Node). */
    _views: Map<Material, StandardGeometryMaterialView | PbrGeometryMaterialView | NodeGeometryMaterialView>;
    /** Render bindings — opaque first then alpha-blended (sorted in record()). */
    _bound: BoundMesh[];
    _wrapperTargets: (RenderTarget | null)[];
    _ownedDepthWrapper: RenderTarget | null;
    _sceneUBO: GPUBuffer;
    _sceneBG: GPUBindGroup;
    _sceneData: Float32Array;
    /** Optional UBO holding `previousViewProjection` + `cameraNearFar`. Allocated
     *  when at least one attachment needs it (LINEAR_VELOCITY or NORMALIZED_VIEW_DEPTH). */
    _paramsUBO: GPUBuffer | null;
    _paramsData: Float32Array | null;
    _previousViewProjection: Float32Array;
    _viewProjectionScratch: Float32Array;
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachments: GPURenderPassColorAttachment[];
    _depthAttachment: GPURenderPassDepthStencilAttachment | null;
    /** Per-mesh previous-world snapshots for the velocity attachment. */
    _previousWorlds: Map<Mesh, Float32Array>;
    /** When true, the task owns the depth attachment via the MRT. */
    _ownedDepth: boolean;
    _excludedFromVelocity: Set<Mesh>;
    _needsVelocity: boolean;
    _needsParams: boolean;
    /** Signature passed to renderable.bind(). Reused — fields are mutated in record().
     *  `_colorFormat` holds the joined format list so the shared pipeline cache key includes
     *  every MRT slot, while `_colorFormats` is the array the geometry renderable consumes
     *  to build `fragment.targets`. */
    _signature: { _colorFormat: string; _colorFormats: GPUTextureFormat[]; _depthStencilFormat?: GPUTextureFormat; _depthCompare?: GPUCompareFunction; _sampleCount: number };
    /** Lazily-loaded material-family bridges. Each is populated by `_preload`
     *  only when at least one mesh resolves to that family, so a Standard-only
     *  scene never pays for the PBR runtime chunk (and vice-versa). */
    _createStandardGeometryView: ((src: StandardMaterialProps, cfg: StandardGeometryViewConfig) => StandardGeometryMaterialView) | null;
    _computeStandardFeatures: ((mat: StandardMaterialProps) => number) | null;
    _createPbrGeometryView: ((src: PbrMaterialProps, cfg: PbrGeometryViewConfig) => PbrGeometryMaterialView) | null;
    _computePbrFeatures: ((mat: PbrMaterialProps) => MaterialRenderFeatures) | null;
    _createNodeGeometryView: ((src: NodeMaterial, cfg: NodeGeometryViewConfig) => NodeGeometryMaterialView) | null;
}

// ─── Factory ───────────────────────────────────────────────────────────────

/** Create a geometry-renderer task. All GPU resources are allocated lazily
 *  during the first `record()` call (when the frame graph is built). */
export function createGeometryRendererTask(config: GeometryRendererTaskConfig, engine: EngineContext, scene: SceneContext): GeometryRendererTask {
    const eng = engine as EngineContext;
    const sc = scene as SceneContext;
    if (config.textureDescriptions.length === 0) {
        throw new Error("GeometryRendererTask: textureDescriptions must contain at least one entry.");
    }
    if (config.textureDescriptions.length > 8) {
        throw new Error(`GeometryRendererTask: textureDescriptions length ${config.textureDescriptions.length} exceeds the WebGPU max of 8 color attachments.`);
    }

    const attachments: AttachmentInfo[] = config.textureDescriptions.map((d, i) => {
        const desc = GEOMETRY_TEXTURE_DESCRIPTIONS[d.type];
        if (!desc) {
            throw new Error(`GeometryRendererTask: unknown texture type ${d.type as number}.`);
        }
        return {
            _type: d.type,
            _index: i,
            _format: d.format ?? desc.defaultFormat,
            _clearValue: d.clearValue ?? desc.clearValue,
        };
    });
    const types = attachments.map((a) => a._type);
    const needsVelocity = types.includes(GeometryTextureType.LINEAR_VELOCITY);
    const needsParams = needsVelocity || types.includes(GeometryTextureType.NORMALIZED_VIEW_DEPTH);
    const samples = config.samples ?? 1;
    const size = config.size ?? sc.surface;

    if (config.depthTexture) {
        const ds = config.depthTexture._descriptor.samples ?? 1;
        if (ds !== samples) {
            throw new Error(`GeometryRendererTask: depthTexture sampleCount (${ds}) must match samples (${samples}).`);
        }
    }

    if (config.targetTexture) {
        const ts = config.targetTexture._descriptor.samples ?? 1;
        if (ts !== samples) {
            throw new Error(`GeometryRendererTask: targetTexture sampleCount (${ts}) must match samples (${samples}).`);
        }
        if (!config.targetTexture._descriptor.format) {
            throw new Error("GeometryRendererTask: targetTexture must have a format.");
        }
    }

    const colorFormats = attachments.map((a) => a._format);
    const outputTarget = createRenderTargetMrt({
        label: config.name ?? "geometry-renderer",
        colorFormats,
        depthStencilFormat: config.depthTexture ? undefined : "depth32float",
        sampleCount: samples,
        size,
    });

    const wrapperTargets: (RenderTarget | null)[] = [];
    const typeAccessors: Record<GeometryTextureType, RenderTarget | null> = {} as Record<GeometryTextureType, RenderTarget | null>;
    for (let t = 0; t < GEOMETRY_TEXTURE_DESCRIPTIONS.length; t++) {
        typeAccessors[t as GeometryTextureType] = null;
    }
    for (const a of attachments) {
        const wrapper = createWrapperRenderTarget(outputTarget, a);
        wrapperTargets.push(wrapper);
        typeAccessors[a._type] = wrapper;
    }

    const ownedDepthWrapper: RenderTarget | null = config.depthTexture ? null : createDepthWrapperRenderTarget(outputTarget, samples);
    const geometryDepthTexture: RenderTarget = config.depthTexture ?? ownedDepthWrapper!;

    const sceneBGL = getSceneBindGroupLayout(eng);
    const sceneUBO = createEmptyUniformBuffer(eng, SCENE_UBO_BYTES);
    const lightsUBO = ensureSceneLightState(eng, sc)._buffer;
    const sceneBG = eng._device.createBindGroup({
        layout: sceneBGL,
        entries: [
            { binding: 0, resource: { buffer: sceneUBO } },
            { binding: 1, resource: { buffer: lightsUBO } },
        ],
    });

    const paramsUBO = needsParams ? createEmptyUniformBuffer(eng, 80) : null;
    const paramsData = needsParams ? new F32(20) : null;

    // Pass color attachments: one per geometry MRT slot + optional trailing
    // target-texture slot (populated each record() from the live RT view).
    const colorAttachments: GPURenderPassColorAttachment[] = attachments.map(() => ({
        view: undefined!,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
    }));
    if (config.targetTexture) {
        const hasClear = config.targetTextureClearColor !== undefined;
        colorAttachments.push({
            view: undefined!,
            loadOp: hasClear ? "clear" : "load",
            storeOp: "store",
            ...(hasClear ? { clearValue: config.targetTextureClearColor! } : {}),
        });
    }
    const renderPassDescriptor: GPURenderPassDescriptor = {
        label: config.name ?? "geometry-renderer",
        colorAttachments,
    };

    // Pipeline signature for renderable.bind(). Includes the optional target
    // texture format when emitColor is set.
    const sigColorFormats = colorFormats.slice();
    if (config.targetTexture) {
        sigColorFormats.push(config.targetTexture._descriptor.format!);
    }
    const signature = {
        _colorFormat: sigColorFormats.join(),
        _colorFormats: sigColorFormats,
        _depthStencilFormat: (config.depthTexture ? config.depthTexture._descriptor.dFormat : outputTarget._descriptor.depthStencilFormat) ?? "depth32float",
        _depthCompare: "greater-equal" as GPUCompareFunction,
        _sampleCount: samples,
    };

    const task: GeometryRendererTaskInternal = {
        name: config.name ?? "geometry-renderer",
        engine: eng,
        scene: sc,
        _passes: [],
        _mrt: outputTarget,
        outputTexture: config.targetTexture,
        geometryDepthTexture,
        geometryIrradianceTexture: typeAccessors[GeometryTextureType.IRRADIANCE],
        geometryWorldPositionTexture: typeAccessors[GeometryTextureType.WORLD_POSITION],
        geometryLocalPositionTexture: typeAccessors[GeometryTextureType.LOCAL_POSITION],
        geometryReflectivityTexture: typeAccessors[GeometryTextureType.REFLECTIVITY],
        geometryViewDepthTexture: typeAccessors[GeometryTextureType.VIEW_DEPTH],
        geometryNormalizedViewDepthTexture: typeAccessors[GeometryTextureType.NORMALIZED_VIEW_DEPTH],
        geometryScreenspaceDepthTexture: typeAccessors[GeometryTextureType.SCREENSPACE_DEPTH],
        geometryViewNormalTexture: typeAccessors[GeometryTextureType.VIEW_NORMAL],
        geometryWorldNormalTexture: typeAccessors[GeometryTextureType.WORLD_NORMAL],
        geometryAlbedoTexture: typeAccessors[GeometryTextureType.ALBEDO],
        geometryLinearVelocityTexture: typeAccessors[GeometryTextureType.LINEAR_VELOCITY],
        excludeFromVelocity(mesh) {
            task._excludedFromVelocity.add(mesh);
        },
        includeInVelocity(mesh) {
            task._excludedFromVelocity.delete(mesh);
        },
        _attachments: attachments,
        _views: new Map(),
        _bound: [],
        _wrapperTargets: wrapperTargets,
        _ownedDepthWrapper: ownedDepthWrapper,
        _sceneUBO: sceneUBO,
        _sceneBG: sceneBG,
        _sceneData: new F32(SCENE_UBO_BYTES / 4),
        _paramsUBO: paramsUBO,
        _paramsData: paramsData,
        _previousViewProjection: new F32(16),
        _viewProjectionScratch: new F32(16),
        _renderPassDescriptor: renderPassDescriptor,
        _colorAttachments: colorAttachments,
        _depthAttachment: null,
        _previousWorlds: new Map(),
        _ownedDepth: false,
        _excludedFromVelocity: new Set(),
        _needsVelocity: needsVelocity,
        _needsParams: needsParams,
        _signature: signature,
        _createStandardGeometryView: null,
        _computeStandardFeatures: null,
        _createPbrGeometryView: null,
        _computePbrFeatures: null,
        _createNodeGeometryView: null,

        async _preload(): Promise<void> {
            const meshes = (config.meshes ?? sc.meshes) as readonly Mesh[];
            let hasStandard = false;
            let hasPbr = false;
            let hasNode = false;
            for (const mesh of meshes) {
                const family = resolveMaterialFamily(mesh.material);
                if (family === "standard") {
                    hasStandard = true;
                } else if (family === "pbr") {
                    hasPbr = true;
                } else if (family === "node") {
                    hasNode = true;
                }
            }
            const loads: Promise<void>[] = [];
            if (hasStandard) {
                loads.push(
                    (async () => {
                        const [viewMod, matMod] = await Promise.all([import("../material/standard/geometry-view.js"), import("../material/standard/standard-material.js")]);
                        task._createStandardGeometryView = viewMod.createStandardGeometryMaterialView;
                        task._computeStandardFeatures = matMod._computeStandardMaterialFeatures;
                    })()
                );
            }
            if (hasPbr) {
                loads.push(
                    (async () => {
                        const [viewMod, matMod] = await Promise.all([import("../material/pbr/pbr-geometry-view.js"), import("../material/pbr/pbr-material.js")]);
                        task._createPbrGeometryView = viewMod.createPbrGeometryMaterialView;
                        task._computePbrFeatures = matMod._computePbrMaterialFeatures;
                    })()
                );
            }
            if (hasNode) {
                loads.push(
                    (async () => {
                        const viewMod = await import("../material/node/node-geometry-view.js");
                        task._createNodeGeometryView = viewMod.createNodeGeometryMaterialView;
                    })()
                );
            }
            await Promise.all(loads);
        },

        record(): void {
            recordTask(task, config, eng, sc);
        },
        execute(): number {
            return executeTask(task, eng, sc, config);
        },
        dispose(): void {
            disposeTask(task);
        },
    };
    return task;
}

// ─── Record ────────────────────────────────────────────────────────────────

function recordTask(task: GeometryRendererTaskInternal, config: GeometryRendererTaskConfig, eng: EngineContext, sc: SceneContext): void {
    buildRenderTargetMrt(task._mrt, eng);
    task._ownedDepth = !config.depthTexture;

    if (config.targetTexture && !config.targetTexture._colorTexture) {
        buildRenderTarget(config.targetTexture, eng);
    }

    const mrt = task._mrt;
    for (const a of task._attachments) {
        const w = task._wrapperTargets[a._index]!;
        w._colorTexture = getSampledColorTexture(mrt, a._index);
        w._colorView = getSampledColorView(mrt, a._index);
        w._width = mrt._width;
        w._height = mrt._height;
    }
    if (task._ownedDepthWrapper) {
        task._ownedDepthWrapper._depthTexture = mrt._depthTexture;
        task._ownedDepthWrapper._depthView = mrt._depthView;
        task._ownedDepthWrapper._width = mrt._width;
        task._ownedDepthWrapper._height = mrt._height;
    }

    const lightsUBO = ensureSceneLightState(eng, sc)._buffer;
    task._sceneBG = eng._device.createBindGroup({
        layout: getSceneBindGroupLayout(eng),
        entries: [
            { binding: 0, resource: { buffer: task._sceneUBO } },
            { binding: 1, resource: { buffer: lightsUBO } },
        ],
    });

    // Discard prior bindings/views; rebuild from the current mesh list.
    task._bound.length = 0;
    task._views.clear();
    task._previousWorlds.clear();

    const meshes = (config.meshes ?? sc.meshes) as readonly Mesh[];
    const attachmentTypes = task._attachments.map((a) => a._type);
    for (const mesh of meshes) {
        const resolved = resolveSourceMaterial(task, mesh.material);
        if (!resolved) {
            continue;
        }
        const view = ensureView(task, resolved, attachmentTypes, config);
        // Natural dispatch — view._buildGroup is the standard or PBR geometry
        // builder, its _rebuildSingle returns the per-mesh geometry-MRT Renderable.
        const renderable: Renderable = view._buildGroup._rebuildSingle!(sc, mesh, view);
        const binding = renderable.bind(eng, task._signature as unknown as RenderTargetSignature);
        task._bound.push({ _mesh: mesh, _binding: binding, _view: view });
        if (task._needsVelocity) {
            task._previousWorlds.set(mesh, new F32(mesh.worldMatrix));
        }
    }

    // Opaque first, then alpha-blended. The alpha pass uses ALPHA_COMBINE
    // with depth-write off — an opaque mesh drawn after a transparent one
    // would overwrite its contribution with src-alpha=1.0.
    task._bound.sort((a, b) => (isAlphaBlend(a._binding.renderable) ? 1 : 0) - (isAlphaBlend(b._binding.renderable) ? 1 : 0));

    rebuildRenderPassDescriptor(task, config);
}

interface ResolvedMaterial {
    _mat: StandardMaterialProps | PbrMaterialProps | NodeMaterial;
    _family: "standard" | "pbr" | "node";
}

function ensureView(
    task: GeometryRendererTaskInternal,
    resolved: ResolvedMaterial,
    attachmentTypes: readonly GeometryTextureType[],
    config: GeometryRendererTaskConfig
): StandardGeometryMaterialView | PbrGeometryMaterialView | NodeGeometryMaterialView {
    const cached = task._views.get(resolved._mat as Material);
    if (cached) {
        return cached;
    }
    const viewConfig = {
        attachments: attachmentTypes,
        emitColor: config.targetTexture !== undefined,
        gpUBO: task._paramsUBO,
        reverseCulling: config.reverseCulling,
    };
    const view =
        resolved._family === "standard"
            ? task._createStandardGeometryView!(resolved._mat as StandardMaterialProps, viewConfig)
            : resolved._family === "pbr"
              ? task._createPbrGeometryView!(resolved._mat as PbrMaterialProps, viewConfig)
              : task._createNodeGeometryView!(resolved._mat as NodeMaterial, viewConfig);
    task._views.set(resolved._mat as Material, view);
    return view;
}

function isAlphaBlend(r: Renderable): boolean {
    return r.isTransparent === true;
}

function rebuildRenderPassDescriptor(task: GeometryRendererTaskInternal, config: GeometryRendererTaskConfig): void {
    const mrt = task._mrt;
    for (const a of task._attachments) {
        const att = task._colorAttachments[a._index]!;
        att.view = mrt._colorViews[a._index]!;
        att.resolveTarget = mrt._resolveColorViews[a._index] ?? undefined;
        att.loadOp = "clear";
        att.storeOp = "store";
        att.clearValue = a._clearValue;
    }
    if (config.targetTexture) {
        const tail = task._colorAttachments[task._attachments.length]!;
        tail.view = config.targetTexture._colorView!;
        tail.resolveTarget = undefined;
    }
    let depthView: GPUTextureView | null;
    let depthFormat: GPUTextureFormat | undefined;
    let depthClearValue: number;
    if (config.depthTexture) {
        depthView = config.depthTexture._depthView;
        depthFormat = config.depthTexture._descriptor.dFormat;
        depthClearValue = config.depthTexture._descriptor._depthClearValue ?? 0;
    } else {
        depthView = mrt._depthView;
        depthFormat = mrt._descriptor.depthStencilFormat;
        depthClearValue = 0;
    }
    task._depthAttachment = depthView
        ? {
              view: depthView,
              depthClearValue,
              depthLoadOp: "clear",
              depthStoreOp: "store",
              ...(depthFormat?.includes("stencil") ? { stencilClearValue: 0, stencilLoadOp: "clear" as const, stencilStoreOp: "store" as const } : {}),
          }
        : null;
    task._renderPassDescriptor.colorAttachments = task._colorAttachments;
    task._renderPassDescriptor.depthStencilAttachment = task._depthAttachment ?? undefined;
}

// ─── Execute ───────────────────────────────────────────────────────────────

function executeTask(task: GeometryRendererTaskInternal, eng: EngineContext, sc: SceneContext, config: GeometryRendererTaskConfig): number {
    const camera = config.camera ?? sc.camera;
    if (!camera) {
        return 0;
    }
    const mrt = task._mrt;
    if (mrt._width === 0 || mrt._height === 0) {
        return 0;
    }
    const aspect = mrt._width / mrt._height;
    writeSceneUBO(task, eng, sc, camera, aspect);
    if (task._needsParams) {
        writeParamsUBO(task, eng, camera);
    }

    // Pre-frame DrawBinding update (mesh UBO refresh, mat UBO version, etc.).
    const updateCtx = { targetWidth: mrt._width, targetHeight: mrt._height, _camera: camera };
    for (const b of task._bound) {
        b._binding.update?.(updateCtx);
    }

    const pass = eng._currentEncoder.beginRenderPass(task._renderPassDescriptor);
    pass.setBindGroup(0, task._sceneBG);
    let lastPipeline: GPURenderPipeline | null = null;
    let draws = 0;
    for (const b of task._bound) {
        if (b._mesh.visible === false) {
            continue;
        }
        const pipeline = b._binding.pipeline;
        if (pipeline !== lastPipeline) {
            pass.setPipeline(pipeline);
            lastPipeline = pipeline;
        }
        draws += b._binding.draw(pass, eng);
        // Snapshot previous-world for velocity attachment.
        if (task._needsVelocity && !task._excludedFromVelocity.has(b._mesh)) {
            const prev = task._previousWorlds.get(b._mesh);
            if (prev) {
                prev.set(b._mesh.worldMatrix);
            }
        }
    }
    pass.end();
    if (task._needsVelocity) {
        task._previousViewProjection.set(task._viewProjectionScratch);
    }
    return draws;
}

function writeSceneUBO(task: GeometryRendererTaskInternal, eng: EngineContext, sc: SceneContext, camera: Camera, aspect: number): void {
    const data = task._sceneData;
    _packSceneUniforms(data, eng, sc, camera, aspect);
    // Run the opt-in fog/clip-plane/env-SH contributors so the geometry pass
    // sees the same SceneUniforms state as the forward render task.
    const contribs = sc._sceneUboContributors;
    if (contribs) {
        for (const c of contribs) {
            c(data, sc);
        }
    }
    task._viewProjectionScratch.set(data.subarray(0, 16));
    eng._device.queue.writeBuffer(task._sceneUBO, 0, data as Float32Array<ArrayBuffer>);
}

function writeParamsUBO(task: GeometryRendererTaskInternal, eng: EngineContext, camera: Camera): void {
    const data = task._paramsData!;
    data.set(task._previousViewProjection, 0);
    data[16] = camera.nearPlane;
    data[17] = camera.farPlane;
    data[18] = 0;
    data[19] = 0;
    eng._device.queue.writeBuffer(task._paramsUBO!, 0, data as Float32Array<ArrayBuffer>);
}

// ─── Dispose ───────────────────────────────────────────────────────────────

function disposeTask(task: GeometryRendererTaskInternal): void {
    task._passes.length = 0;
    task._bound.length = 0;
    task._views.clear();
    task._previousWorlds.clear();
    disposeRenderTargetMrt(task._mrt);
    task._ownedDepth = false;
    task._sceneUBO.destroy();
    task._paramsUBO?.destroy();
    task._wrapperTargets.length = 0;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Resolve a mesh's material family without importing any family runtime —
 *  reads only the build-group tag. Used by `_preload` to decide which family
 *  bridges to dynamically import. */
function resolveMaterialFamily(material: Material | null | undefined): "standard" | "pbr" | "node" | null {
    if (!material) {
        return null;
    }
    const family = getMaterialSource(material)._buildGroup?._materialFamily;
    return family === "standard" || family === "pbr" || family === "node" ? family : null;
}

function resolveSourceMaterial(task: GeometryRendererTaskInternal, material: Material | null | undefined): ResolvedMaterial | null {
    if (!material) {
        return null;
    }
    const src = getMaterialSource(material) as Material & { _renderFeatures?: { features: number } };
    const buildGroup = src._buildGroup;
    if (!buildGroup) {
        return null;
    }
    if (buildGroup._materialFamily === "standard") {
        const mat = src as StandardMaterialProps;
        if (!mat._renderFeatures) {
            mat._renderFeatures = { features: task._computeStandardFeatures!(mat) };
        }
        return { _mat: mat, _family: "standard" };
    }
    if (buildGroup._materialFamily === "pbr") {
        const mat = src as PbrMaterialProps;
        if (!mat._renderFeatures) {
            mat._renderFeatures = task._computePbrFeatures!(mat);
        }
        return { _mat: mat, _family: "pbr" };
    }
    if (buildGroup._materialFamily === "node") {
        // Node materials carry their own `_renderFeatures` (set at parse time)
        // and own all geometry-shader emission, so no feature computation is needed.
        return { _mat: src as NodeMaterial, _family: "node" };
    }
    return null;
}

/** Build a wrapper RenderTarget that aliases one MRT attachment as a regular
 *  single-attachment RT. The wrapper is `_eager: true`: `buildRenderTarget`
 *  becomes a no-op and `disposeRenderTarget` will not destroy the shared
 *  underlying texture. Slots are populated by `recordTask`. */
function createWrapperRenderTarget(mrt: RenderTargetMrt, attachment: AttachmentInfo): RenderTarget {
    const baseDesc = mrt._descriptor;
    const wrapperDesc: RenderTargetDescriptor = {
        lbl: `${baseDesc.label ?? "geometry"}.${attachment._index}`,
        format: attachment._format,
        samples: 1,
        size: baseDesc.size,
    };
    return {
        _descriptor: wrapperDesc,
        _colorTexture: null,
        _colorView: null,
        _depthTexture: null,
        _depthView: null,
        _width: 0,
        _height: 0,
        _eager: true,
    };
}

function createDepthWrapperRenderTarget(mrt: RenderTargetMrt, sampleCount: number): RenderTarget {
    const baseDesc = mrt._descriptor;
    const wrapperDesc: RenderTargetDescriptor = {
        lbl: `${baseDesc.label ?? "geometry"}.depth`,
        dFormat: baseDesc.depthStencilFormat,
        samples: sampleCount,
        size: baseDesc.size,
    };
    return {
        _descriptor: wrapperDesc,
        _colorTexture: null,
        _colorView: null,
        _depthTexture: null,
        _depthView: null,
        _width: 0,
        _height: 0,
        _eager: true,
    };
}
