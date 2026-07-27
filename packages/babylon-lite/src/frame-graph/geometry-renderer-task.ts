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
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { ensureSceneLightState, getLightsUboSize, _writeTaskLightsData } from "../render/lights-ubo.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-size.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Task } from "./task.js";
import type { GeometryClearValue } from "./geometry-types.js";
import { GEOMETRY_TEXTURE_DESCRIPTIONS, GeometryTextureType } from "./geometry-types.js";
import { _packSceneUniforms } from "./scene-uniforms-pack.js";
import { getProjectionMatrix } from "../camera/camera.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import type { Mat4Storage } from "../math/types.js";

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
    /** Meshes explicitly removed from this scene. Needed only for caller-supplied
     *  `config.meshes`, which may contain off-scene meshes and therefore cannot be
     *  filtered by `scene.meshes` alone. Cleared for a mesh when it is re-added. */
    _removedMeshes: WeakSet<Mesh> | null;
    /** Scene `_renderableVersion` captured at the last `_bound` (re)build. When the
     *  scene mutates (mesh add/remove or material swap both bump `_renderableVersion`),
     *  `execute` re-syncs `_bound` before drawing so a removed mesh is not drawn against
     *  destroyed UBOs/vertex buffers and a swapped material's view is rebuilt — mirroring
     *  the forward RenderTask's `_lastVersion` auto-resync. `-1` until first record. */
    _boundVer: number;
    /** Task-owned lights UBO holding positional light data relative to a
     *  `config.camera` override under floating origin. Null when the task uses the
     *  scene's active camera (it then binds the shared scene lights state, which is
     *  already relative to that camera). */
    _ownLightsUBO: GPUBuffer | null;
    _ownLightsScratch: Float32Array | null;
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
        _removedMeshes: null,
        _boundVer: -1,
        _ownLightsUBO: null,
        _ownLightsScratch: null,
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

        _removeMesh(value: object): void {
            (task._removedMeshes ??= new WeakSet()).add(value as Mesh);
        },

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
                        await viewMod.preloadStandardGeometryFeatures(meshes, task._needsVelocity);
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
            disposeTask(task, eng, sc);
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

    const lightsUBO = _resolveTaskLightsUBO(task, eng, sc, config);
    task._sceneBG = eng._device.createBindGroup({
        layout: getSceneBindGroupLayout(eng),
        entries: [
            { binding: 0, resource: { buffer: task._sceneUBO } },
            { binding: 1, resource: { buffer: lightsUBO } },
        ],
    });
    // Rebuild the per-mesh bindings/views (make-before-break, retiring the prior
    // set's owned GPU resources) then sync the render-pass descriptor.
    rebuildBoundMeshes(task, config, eng, sc);
    rebuildRenderPassDescriptor(task, config);
}

/** (Re)build the task's per-mesh `_bound` list + `_views` from the current mesh set,
 *  retiring the prior set's owned GPU resources make-before-break, and record the
 *  scene mutation version it reflects. Called at `record()` and again from `execute()`
 *  whenever `sc._renderableVersion` advances (mesh removal or material swap) so the task
 *  never draws a removed mesh's destroyed UBOs/vertex buffers or a swapped material's
 *  stale view. The mesh source mirrors `record()`: the common auto path (`config.meshes`
 *  omitted) reads `sc.meshes`; caller-supplied off-scene meshes remain supported, while
 *  the task-local removal list excludes meshes explicitly removed through `removeFromScene`. */
function rebuildBoundMeshes(task: GeometryRendererTaskInternal, config: GeometryRendererTaskConfig, eng: EngineContext, sc: SceneContext): void {
    // Discard prior bindings/views, but retire their owned GPU resources instead
    // of dropping the references and leaking (per-mesh geometry UBOs, skeletal
    // velocity textures, and the views' shared material/UV UBOs). Make-before-
    // break: capture the old set, build the new bindings/views below, then retire
    // the old ones after the next submitted frame drains (a previously recorded
    // command buffer may still reference them). Idempotent disposers keep this
    // safe against the `_meshAuxDisposables` removal drain.
    const oldBound = task._bound;
    const oldViews = [...task._views.values()];
    const nextBound: BoundMesh[] = [];
    const nextViews = new Map<Material, StandardGeometryMaterialView | PbrGeometryMaterialView | NodeGeometryMaterialView>();
    const removed = task._removedMeshes;
    const meshes = config.meshes ?? sc.meshes;
    const attachmentTypes = task._attachments.map((a) => a._type);
    try {
        for (const mesh of meshes) {
            if (removed?.has(mesh)) {
                if (!sc.meshes.includes(mesh)) {
                    continue;
                }
                removed.delete(mesh);
            }
            const resolved = resolveSourceMaterial(task, mesh.material);
            if (!resolved) {
                continue;
            }
            const view = ensureView(task, nextViews, resolved, attachmentTypes, config);
            // Natural dispatch — view._buildGroup is the standard or PBR geometry
            // builder, its _rebuildSingle returns the per-mesh geometry-MRT Renderable.
            const renderable: Renderable = view._buildGroup._rebuildSingle!(sc, mesh, view);
            const binding = renderable.bind(eng, task._signature as unknown as RenderTargetSignature);
            nextBound.push({ _mesh: mesh, _binding: binding, _view: view });
        }
    } catch (error) {
        retireGeometryBindings(eng, sc, nextBound, [...nextViews.values()]);
        throw error;
    }

    // Opaque first, then alpha-blended. The alpha pass uses ALPHA_COMBINE
    // with depth-write off — an opaque mesh drawn after a transparent one
    // would overwrite its contribution with src-alpha=1.0.
    nextBound.sort((a, b) => (isAlphaBlend(a._binding.renderable) ? 1 : 0) - (isAlphaBlend(b._binding.renderable) ? 1 : 0));

    task._bound = nextBound;
    task._views = nextViews;
    task._boundVer = sc._renderableVersion;

    if (oldBound.length > 0 || oldViews.length > 0) {
        retireGeometryBindings(eng, sc, oldBound, oldViews);
    }
}

/** Retire the GPU resources owned by a discarded set of geometry bindings/views.
 *  Per-mesh renderables expose `_geometryDispose`; views expose
 *  `_disposeGeometryResources`. Both are idempotent, so retiring here is safe even
 *  when the mesh is later removed (which drains the same per-mesh disposer through
 *  `_meshAuxDisposables`). The per-mesh disposers do NOT self-remove from the aux
 *  list, so this function first detaches them SYNCHRONOUSLY (outside any scene drain,
 *  so no iteration is corrupted) to keep the list from growing across re-records,
 *  then defers the actual GPU frees via `retireGpuResources` so an in-flight frame's
 *  command buffer never references a destroyed buffer. */
function retireGeometryBindings(
    eng: EngineContext,
    sc: SceneContext,
    bound: readonly BoundMesh[],
    views: readonly (StandardGeometryMaterialView | PbrGeometryMaterialView | NodeGeometryMaterialView)[]
): void {
    // Detach the owned aux disposers now (safe: not during a scene drain).
    for (const b of bound) {
        const dispose = b._binding.renderable._geometryDispose;
        if (!dispose) {
            continue;
        }
        const list = sc._meshAuxDisposables.get(b._mesh);
        if (!list) {
            continue;
        }
        const i = list.indexOf(dispose);
        if (i >= 0) {
            list.splice(i, 1);
        }
        if (list.length === 0) {
            sc._meshAuxDisposables.delete(b._mesh);
        }
    }
    retireGpuResources(eng, () => {
        for (const b of bound) {
            b._binding.renderable._geometryDispose?.();
        }
        for (const v of views) {
            (v as StandardGeometryMaterialView)._disposeGeometryResources?.();
        }
    });
}

interface ResolvedMaterial {
    _mat: StandardMaterialProps | PbrMaterialProps | NodeMaterial;
    _family: "standard" | "pbr" | "node";
}

function ensureView(
    task: GeometryRendererTaskInternal,
    views: Map<Material, StandardGeometryMaterialView | PbrGeometryMaterialView | NodeGeometryMaterialView>,
    resolved: ResolvedMaterial,
    attachmentTypes: readonly GeometryTextureType[],
    config: GeometryRendererTaskConfig
): StandardGeometryMaterialView | PbrGeometryMaterialView | NodeGeometryMaterialView {
    const cached = views.get(resolved._mat as Material);
    if (cached) {
        return cached;
    }
    const viewConfig = {
        attachments: attachmentTypes,
        emitColor: config.targetTexture !== undefined,
        gpUBO: task._paramsUBO,
        reverseCulling: config.reverseCulling,
        // Effective task camera flows to EVERY geometry family so their world /
        // previous-world packing + floating-origin invalidation share the same
        // origin as the task's view/projection + positional lights.
        camera: config.camera ?? null,
    };
    const view =
        resolved._family === "standard"
            ? task._createStandardGeometryView!(resolved._mat as StandardMaterialProps, {
                  ...viewConfig,
                  velocityExclusions: task._excludedFromVelocity,
              })
            : resolved._family === "pbr"
              ? task._createPbrGeometryView!(resolved._mat as PbrMaterialProps, viewConfig)
              : task._createNodeGeometryView!(resolved._mat as NodeMaterial, viewConfig);
    views.set(resolved._mat as Material, view);
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

// ─── Effective-camera floating-origin coherence ──────────────────────────────

/** Whether the task must maintain its OWN floating-origin state relative to a
 *  `config.camera` override — a distinct positional-light and view origin. Only
 *  meaningful under floating origin AND when an override camera is supplied; the
 *  scene's active camera already carries the FO flag and the shared scene lights
 *  are already offset against it. */
function _usesOverrideFO(eng: EngineContext, config: GeometryRendererTaskConfig): boolean {
    return !!eng.useFloatingOrigin && !!config.camera;
}

/** Resolve the lights UBO bound at scene-BG slot 1: the task-owned override-relative
 *  UBO under override-FO (lazily allocated empty here, filled per-frame by
 *  {@link _refreshTaskLightsUBO}), else the shared scene lights UBO. */
function _resolveTaskLightsUBO(task: GeometryRendererTaskInternal, eng: EngineContext, sc: SceneContext, config: GeometryRendererTaskConfig): GPUBuffer {
    if (!_usesOverrideFO(eng, config)) {
        return ensureSceneLightState(eng, sc)._buffer;
    }
    if (!task._ownLightsUBO) {
        task._ownLightsScratch = new F32(getLightsUboSize() / 4);
        task._ownLightsUBO = createEmptyUniformBuffer(eng, getLightsUboSize());
    }
    return task._ownLightsUBO;
}

/** Per-frame fill of the task-owned lights UBO: positional lights offset by the
 *  OVERRIDE camera (not the scene's active camera), so they share the same origin as
 *  the task's world/view packing. No-op without override-FO. */
function _refreshTaskLightsUBO(task: GeometryRendererTaskInternal, eng: EngineContext, sc: SceneContext, config: GeometryRendererTaskConfig): void {
    const scratch = task._ownLightsScratch;
    if (!scratch || !_usesOverrideFO(eng, config)) {
        return;
    }
    _writeTaskLightsData(eng, scratch, { camera: config.camera!, lights: sc.lights } as unknown as SceneContext);
    eng._device.queue.writeBuffer(task._ownLightsUBO!, 0, scratch as Float32Array<ArrayBuffer>);
}

/** Under floating origin, force the packed view (and view-projection at data[0..15])
 *  origin-relative to the EFFECTIVE task camera, regardless of whether that camera
 *  carries the scene's `_useFloatingOrigin` flag. A `config.camera` override never
 *  becomes the scene's active camera, so `scene._update` never sets that flag on it
 *  and `getViewMatrix` would otherwise leave the large absolute translation in —
 *  desynced from the origin-relative mesh/previous-world/light packing. Zeroing the
 *  view translation column (view is at data[16..31]; translation at 12..14 → 28..30)
 *  and re-multiplying by the projection reproduces exactly what an FO-flagged camera
 *  yields; for a camera that already carries the flag this is an idempotent no-op. */
function _forceFoView(data: Float32Array, camera: Camera, aspect: number): void {
    data[28] = 0;
    data[29] = 0;
    data[30] = 0;
    const proj = getProjectionMatrix(camera, aspect) as unknown as Mat4Storage;
    mat4MultiplyInto(data as unknown as Mat4Storage, 0, proj, 0, data as unknown as Mat4Storage, 16);
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
    // Re-sync `_bound` before drawing when the scene mutated since the last (re)build.
    // Mesh removal and material swap both bump `sc._renderableVersion`; without this a
    // stale `_bound` entry would bind a removed mesh's destroyed UBOs/vertex buffers or
    // a swapped material's old view. `rebuildBoundMeshes` retires the prior set
    // make-before-break, so the frame just submitted stays valid. Mirrors the forward
    // RenderTask's `_lastVersion` auto-resync in `prepareRenderTaskPass`.
    if (sc._renderableVersion !== task._boundVer) {
        rebuildBoundMeshes(task, config, eng, sc);
    }
    const aspect = mrt._width / mrt._height;
    writeSceneUBO(task, eng, sc, camera, aspect);
    // Positional light data must share the effective task camera's origin; under an
    // override-FO the task owns its lights UBO and refreshes it here each frame.
    _refreshTaskLightsUBO(task, eng, sc, config);
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
    // Force the view/view-projection origin-relative to the EFFECTIVE camera under
    // floating origin (handles a `config.camera` override that never carried the
    // scene's FO flag). Must run before capturing `_viewProjectionScratch` so the
    // previous-frame VP used for velocity is also origin-relative.
    if (eng.useFloatingOrigin) {
        _forceFoView(data, camera, aspect);
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

function disposeTask(task: GeometryRendererTaskInternal, eng: EngineContext, sc: SceneContext): void {
    // Retire the per-mesh + per-view GPU resources this task still owns before
    // dropping the references (otherwise the shared material/UV UBOs and per-mesh
    // mesh UBOs leak on task teardown). Deferred so an in-flight frame that still
    // references them submits safely first. Pass a DETACHED copy of `_bound` (and a
    // views snapshot) because the deferred retirement runs after `task._bound` is
    // emptied below — sharing the live array would leave the callback with nothing
    // to dispose.
    if (task._bound.length > 0 || task._views.size > 0) {
        retireGeometryBindings(eng, sc, [...task._bound], [...task._views.values()]);
    }
    task._passes.length = 0;
    task._bound.length = 0;
    task._views.clear();
    disposeRenderTargetMrt(task._mrt);
    task._ownedDepth = false;
    task._sceneUBO.destroy();
    task._paramsUBO?.destroy();
    task._ownLightsUBO?.destroy();
    task._ownLightsUBO = null;
    task._ownLightsScratch = null;
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
