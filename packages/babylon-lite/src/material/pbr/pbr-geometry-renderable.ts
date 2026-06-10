/** PBR geometry-MRT renderable factory.
 *
 *  Builds a {@link Renderable} that draws a single mesh through a
 *  {@link createPbrGeometryMaterialView} into the geometry renderer task's
 *  multi-attachment render target. Mirrors the regular PBR per-mesh
 *  rebuildSingle closure (mesh UBO, material UBO, mesh bind group with env +
 *  shadows, draw closure) but swaps the single-target pipeline for a
 *  multi-color-attachment one built from the geometry-output shader.
 *
 *  Per-(view, mesh-feature-variant) shared state — composed shader, mesh
 *  BGL, pipeline cache — is cached on `view._geometry` keyed by the
 *  shader-relevant mesh-feature bits + (features, features2, sceneFeatures,
 *  lightMode, singleLightType). Per-mesh state (UBOs, bind group, sort
 *  centre) lives in the closure returned by {@link buildPbrGeometryRenderable}.
 *
 *  This module is imported only by {@link createPbrGeometryMaterialView} —
 *  PBR scenes that don't use the geometry renderer task pay zero bytes for
 *  it. */

import { F32 } from "../../engine/typed-arrays.js";
import type { EngineContext } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshGroupBuilder, Renderable } from "../../render/renderable.js";
import { writeMeshLightSelection } from "../../render/lights-ubo.js";
import type { SceneContext } from "../../scene/scene-core.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import { acquireTexture, releaseTexture } from "../../resource/gpu-pool.js";
import type { ComposedShader } from "../../shader/fragment-types.js";
import { targetSignatureKey, REVERSE_DEPTH_COMPARE } from "../../engine/render-target.js";
import { packMat4IntoF32 } from "../../math/pack-mat4-into-f32.js";
import { _computeMeshFeatures, MSH_HAS_INSTANCE_COLOR, MSH_HAS_THIN_INSTANCES, MSH_HAS_TANGENTS, MSH_HAS_UV2, MSH_HAS_VERTEX_COLOR } from "../mesh-features.js";
import type { Material } from "../material.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";

import type { PbrMaterialProps } from "./pbr-material.js";
import { collectPbrBoundTextures } from "./pbr-material.js";
import { _computePbrMaterialFeatures } from "./pbr-material.js";
import { PBR_HAS_ALPHA_BLEND, PBR_HAS_DOUBLE_SIDED, PBR_HAS_NORMAL_MAP, PBR2_HAS_UV2 } from "./pbr-flags.js";
import { createPbrMeshBindGroup } from "./pbr-pipeline.js";
import type { _PbrGeometryContext } from "./pbr-renderable.js";
import { _writeMaterialData } from "./pbr-renderable.js";
import type { PbrGeometryMaterialView } from "./pbr-geometry-view.js";
import { composePbrGeometryShader, _ensurePbrGeometryExt } from "./pbr-geometry-output-shader.js";
import { _setActivePbrGeometryAttachments } from "./pbr-geometry-view.js";

/** Singleton {@link MeshGroupBuilder} that geometry views point at via their
 *  overridden `_buildGroup`. The async builder body is unreachable —
 *  geometry views are dispatched per-mesh via `_rebuildSingle` directly. */
export const pbrGeometryGroupBuilder: MeshGroupBuilder = (async () => {
    throw new Error("pbr-geometry view does not support scene group building");
}) as MeshGroupBuilder;
pbrGeometryGroupBuilder._rebuildSingle = (scene: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable => {
    const view = (materialOverride ?? mesh.material) as PbrGeometryMaterialView;
    return buildPbrGeometryRenderable(scene, mesh, view);
};
pbrGeometryGroupBuilder._materialFamily = "pbr";

interface PbrGeometryViewResources {
    _composed: ComposedShader;
    _features: number;
    _features2: number;
    _meshFeatures: number;
    _sceneFeatures: number;
    _meshBGL: GPUBindGroupLayout;
    _shadowBGL: GPUBindGroupLayout | null;
    _pipelineLayout: GPUPipelineLayout;
    _vertModule: GPUShaderModule;
    _fragModule: GPUShaderModule;
    _pipelines: Map<string, GPURenderPipeline>;
    _alphaBlend: boolean;
}

function _variantKey(meshFeatures: number, lightMode: number, singleLightType: string): string {
    return `${meshFeatures}:${lightMode}:${singleLightType}`;
}

/** Build a {@link Renderable} for one mesh drawn through a PBR geometry view. */
export function buildPbrGeometryRenderable(scene: SceneContext, mesh: Mesh, view: PbrGeometryMaterialView): Renderable {
    const engine = scene.engine as EngineContext;
    const device = engine._device;

    const ctx = (scene as SceneContext & { _pbrGeomContext?: _PbrGeometryContext })._pbrGeomContext;
    if (!ctx) {
        throw new Error("buildPbrGeometryRenderable: scene has no PBR context. Ensure regular PBR meshes have been built before recording the geometry task.");
    }

    const source = view.source as PbrMaterialProps;
    if (!source._renderFeatures) {
        source._renderFeatures = _computePbrMaterialFeatures(source);
    }

    // Light selection mirrors regular PBR rebuildSingle, gated by the same
    // shadow rules so the geometry-pass real-color attachment receives the
    // same lighting as the regular PBR pass would have produced.
    const lr = writeMeshLightSelection(mesh, scene.lights);
    const lightCount = lr > 0 ? 1 : -lr;
    const hasSomeShadows = ctx._shadowLights.length > 0;
    const receiveShadows = mesh.receiveShadows && hasSomeShadows;
    const lightMode: 0 | 1 | 2 = lightCount === 0 ? 0 : lightCount === 1 && !receiveShadows ? 1 : 2;
    const singleLightType = lightMode === 1 ? _getPackedSingleLightType(scene.lights, lr - 1) : "";
    const meshFeatures = _computeMeshFeatures(mesh, receiveShadows);

    const variantKey = _variantKey(meshFeatures, lightMode, singleLightType);
    const res = _ensureViewResources(view, engine, ctx, meshFeatures, lightMode, singleLightType, variantKey);

    const features = res._features;
    const features2 = res._features2;
    const composed = res._composed;

    // ── Mesh UBO ───────────────────────────────────────────────────────
    const meshUboData = new F32(composed._meshUboSpec._totalBytes / 4);
    const _packMeshWorld = engine._makePackMeshWorld?.(scene) ?? packMat4IntoF32;
    _packMeshWorld(meshUboData, mesh.worldMatrix, 0, 0);
    writeMeshLightSelection(mesh, scene.lights, meshUboData);
    const meshUBO = createUniformBuffer(engine, meshUboData);

    // ── Material UBO ───────────────────────────────────────────────────
    const materialSpec = composed._materialUboSpec!;
    const matInitData = new F32(materialSpec._totalBytes / 4);
    // Use the per-scene writer captured on the geometry context.
    _writePbrMaterialData(matInitData, source, materialSpec);
    const materialUBO = createUniformBuffer(engine, matInitData);

    // ── Mesh bind group (group 1). Pass the VIEW as the "material" so the
    //    PBR geometry ext can read `view._gpUBO`. The view inherits all
    //    source fields via its prototype chain, so other ext bind callbacks
    //    that look at source.* still resolve correctly.
    //
    //    Bind during a scope where `_activeAttachments` is set so that any
    //    composePbr cache miss inside `createPbrMeshBindGroup` (none expected
    //    here, but defensive) sees the right attachments.
    const prev = _setActivePbrGeometryAttachments(view._geometryAttachments);
    let materialBindGroupStatic: GPUBindGroup;
    try {
        materialBindGroupStatic = createPbrMeshBindGroup(engine, _wrapBindings(res), composed, meshUBO, materialUBO, view as unknown as PbrMaterialProps, ctx._envTextures, mesh);
    } finally {
        _setActivePbrGeometryAttachments(prev);
    }

    // ── Shadow bind group (group 2) ────────────────────────────────────
    let shadowBindGroup: GPUBindGroup | null = null;
    if (receiveShadows && res._shadowBGL) {
        const entries: GPUBindGroupEntry[] = [];
        let b = 0;
        for (const sl of ctx._shadowLights) {
            const sg = sl.gen;
            entries.push({ binding: b++, resource: sg._depthTexture.createView() });
            entries.push({ binding: b++, resource: sg._depthSampler });
            entries.push({ binding: b++, resource: { buffer: sg._shadowUBO } });
        }
        shadowBindGroup = device.createBindGroup({ layout: res._shadowBGL, entries });
    }

    // ── Texture acquire/release lifecycle ──────────────────────────────
    const boundTextures = collectPbrBoundTextures(source);
    for (const t of boundTextures) {
        acquireTexture(t);
    }
    const prevDisposables = scene._meshDisposables.get(mesh) ?? [];
    scene._meshDisposables.set(mesh, [
        ...prevDisposables,
        () => {
            meshUBO.destroy();
            materialUBO.destroy();
        },
        () => {
            for (const t of boundTextures) {
                releaseTexture(t);
            }
        },
    ]);

    const hasNormalMap = (features & PBR_HAS_NORMAL_MAP) !== 0 && (meshFeatures & MSH_HAS_TANGENTS) !== 0;
    const hasUV2 = (features2 & PBR2_HAS_UV2) !== 0 && (meshFeatures & MSH_HAS_UV2) !== 0;
    const hasVertexColor = (meshFeatures & MSH_HAS_VERTEX_COLOR) !== 0;
    const hasTI = (meshFeatures & MSH_HAS_THIN_INSTANCES) !== 0;
    const hasTIColor = (meshFeatures & MSH_HAS_INSTANCE_COLOR) !== 0;
    const syncThinInstanceBuffers = ctx._syncThinInstanceBuffers;
    const isAlphaBlend = res._alphaBlend;
    const sortCenter = [mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!] as [number, number, number];

    let _lastWorldVersion = mesh.worldMatrixVersion;
    let _lastLightsCount = scene.lights.length;
    let _lastUboVersion = source._uboVersion;
    const matScratch = new F32(materialSpec._totalBytes / 4);

    const _baseUpdate = (): void => {
        if (mesh.worldMatrixVersion !== _lastWorldVersion || scene.lights.length !== _lastLightsCount) {
            sortCenter[0] = mesh.worldMatrix[12]!;
            sortCenter[1] = mesh.worldMatrix[13]!;
            sortCenter[2] = mesh.worldMatrix[14]!;
            _packMeshWorld(meshUboData, mesh.worldMatrix, 0, 0);
            writeMeshLightSelection(mesh, scene.lights, meshUboData);
            device.queue.writeBuffer(meshUBO, 0, meshUboData as Float32Array<ArrayBuffer>);
            _lastWorldVersion = mesh.worldMatrixVersion;
            _lastLightsCount = scene.lights.length;
        }
        if (source._uboVersion !== _lastUboVersion) {
            _lastUboVersion = source._uboVersion;
            matScratch.fill(0);
            _writePbrMaterialData(matScratch, source, materialSpec);
            device.queue.writeBuffer(materialUBO, 0, matScratch.buffer, 0, matScratch.byteLength);
        }
    };
    const _invalidate = (): void => {
        _lastWorldVersion = -1;
    };
    const update = engine._wrapRenderableForFO?.(_baseUpdate, scene, _invalidate) ?? _baseUpdate;

    const draw = (pass: GPURenderPassEncoder | GPURenderBundleEncoder): number => {
        if (mesh.visible === false) {
            return 0;
        }
        const gpu = mesh._gpu;
        pass.setBindGroup(1, materialBindGroupStatic);
        if (shadowBindGroup) {
            pass.setBindGroup(2, shadowBindGroup);
        }
        let slot = 0;
        const vb = gpu._vbLayout;
        pass.setVertexBuffer(slot++, gpu.positionBuffer, vb?._p?._offset);
        pass.setVertexBuffer(slot++, gpu.normalBuffer, vb?._n?._offset);
        if (hasNormalMap && gpu.tangentBuffer) {
            pass.setVertexBuffer(slot++, gpu.tangentBuffer, vb?._t?._offset);
        }
        pass.setVertexBuffer(slot++, gpu.uvBuffer, vb?._u?._offset);
        if (hasUV2 && gpu.uv2Buffer) {
            pass.setVertexBuffer(slot++, gpu.uv2Buffer, vb?._u2?._offset);
        }
        if (hasVertexColor && gpu.colorBuffer) {
            pass.setVertexBuffer(slot++, gpu.colorBuffer, vb?._c?._offset);
        }
        // Skinning vertex buffers: live skeleton OR baked VAT (same field names, mutually exclusive).
        // Mirrors the main PBR renderable — without the VAT branch, VAT-animated thin instances leave the
        // pipeline's joint/weight vertex slots unbound (invalid command buffer, black frame).
        const skin = mesh.skeleton ?? mesh.vat;
        if (skin) {
            pass.setVertexBuffer(slot++, skin.jointsBuffer);
            pass.setVertexBuffer(slot++, skin.weightsBuffer);
            if (skin.joints1Buffer && skin.weights1Buffer) {
                pass.setVertexBuffer(slot++, skin.joints1Buffer);
                pass.setVertexBuffer(slot++, skin.weights1Buffer);
            }
        }
        const ti = hasTI ? mesh.thinInstances : null;
        if (ti && syncThinInstanceBuffers) {
            slot = syncThinInstanceBuffers(engine, ti, pass, slot, hasTIColor);
        }
        pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
        if (ti && ti.count > 0) {
            pass.drawIndexed(gpu.indexCount, ti.count);
        } else {
            pass.drawIndexed(gpu.indexCount);
        }
        return 1;
    };

    const r: Renderable = {
        order: mesh.renderOrder ?? (isAlphaBlend ? 200 : 100),
        isTransparent: isAlphaBlend,
        mesh,
        bind(eng: EngineContext, sig: RenderTargetSignature) {
            return {
                renderable: r,
                pipeline: _getOrCreateGeometryPipeline(eng as EngineContext, sig, view, res),
                update,
                draw,
            };
        },
    };
    r._worldCenter = sortCenter;
    return r;
}

// ─── Shared per-view resources ─────────────────────────────────────────

function _ensureViewResources(
    view: PbrGeometryMaterialView,
    engine: EngineContext,
    ctx: _PbrGeometryContext,
    meshFeatures: number,
    lightMode: 0 | 1 | 2,
    singleLightType: string,
    variantKey: string
): PbrGeometryViewResources {
    let cache = view._geometry as Map<string, PbrGeometryViewResources> | undefined;
    if (!cache) {
        cache = new Map();
        Object.defineProperty(view, "_geometry", { value: cache, enumerable: false, configurable: true });
    }
    const cached = cache.get(variantKey);
    if (cached) {
        return cached;
    }
    // Ensure the PBR geometry ext is registered (idempotent) before composePbr is called.
    _ensurePbrGeometryExt(() => view._geometryAttachments);

    const features = view._renderFeatures.features;
    const features2 = view._renderFeatures.features2 ?? 0;
    const sceneFeatures = ctx._sceneFeatures;
    const source = view.source as PbrMaterialProps;
    const vbLayout = (source as unknown as { _vbLayout?: import("../../mesh/mesh.js").MeshVbLayout })._vbLayout;
    const vbKey = "";

    // Compose with the active-attachment scope set so the registered ext
    // sees the right list when contributing the geometry-params fragment.
    const prev = _setActivePbrGeometryAttachments(view._geometryAttachments);
    let composed: ComposedShader;
    try {
        composed = composePbrGeometryShader(
            ctx._composePbr,
            features,
            features2,
            meshFeatures,
            sceneFeatures,
            lightMode,
            singleLightType,
            "",
            vbLayout,
            vbKey,
            view._geometryAttachments,
            view._emitColor
        );
    } finally {
        _setActivePbrGeometryAttachments(prev);
    }

    const device = engine._device;
    const meshBGL = device.createBindGroupLayout(composed._meshBGLDescriptor);
    const shadowBGL = composed._shadowBGLDescriptor ? device.createBindGroupLayout(composed._shadowBGLDescriptor) : null;
    const sceneBGL = (engine as unknown as { _getSceneBGL: () => GPUBindGroupLayout })._getSceneBGL?.() ?? _getSceneBindGroupLayoutLocal(engine, composed);
    const bgls: GPUBindGroupLayout[] = shadowBGL ? [sceneBGL, meshBGL, shadowBGL] : [sceneBGL, meshBGL];
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: bgls });
    const vertModule = device.createShaderModule({ code: composed._vertexWGSL });
    const fragModule = device.createShaderModule({ code: composed._fragmentWGSL });

    // The view's features have PBR_HAS_ALPHA_BLEND already stripped. Detect
    // alpha-blend from the SOURCE so transparent meshes get the right blend
    // pipeline state below.
    const sourceFeatures = source._renderFeatures?.features ?? 0;
    const alphaBlend = (sourceFeatures & PBR_HAS_ALPHA_BLEND) !== 0;

    const res: PbrGeometryViewResources = {
        _composed: composed,
        _features: features,
        _features2: features2,
        _meshFeatures: meshFeatures,
        _sceneFeatures: sceneFeatures,
        _meshBGL: meshBGL,
        _shadowBGL: shadowBGL,
        _pipelineLayout: pipelineLayout,
        _vertModule: vertModule,
        _fragModule: fragModule,
        _pipelines: new Map(),
        _alphaBlend: alphaBlend,
    };
    cache.set(variantKey, res);
    return res;
}

/** Adapter so `createPbrMeshBindGroup` (which takes `_PbrShaderBindings`) can
 *  consume our view resources. Only the fields it touches matter. */
function _wrapBindings(res: PbrGeometryViewResources): Parameters<typeof createPbrMeshBindGroup>[1] {
    return {
        _features: res._features,
        _features2: res._features2,
        _meshFeatures: res._meshFeatures,
        _meshBGL: res._meshBGL,
        _shadowBGL: res._shadowBGL,
        _composed: res._composed,
        _pipelines: res._pipelines,
    } as Parameters<typeof createPbrMeshBindGroup>[1];
}

/** Local fallback used when the engine does not expose a centralised scene BGL
 *  cache helper. Matches the layout produced by `getSceneBindGroupLayout`. */
function _getSceneBindGroupLayoutLocal(engine: EngineContext, _composed: ComposedShader): GPUBindGroupLayout {
    return getSceneBindGroupLayout(engine);
}

function _getOrCreateGeometryPipeline(engine: EngineContext, sig: RenderTargetSignature, view: PbrGeometryMaterialView, res: PbrGeometryViewResources): GPURenderPipeline {
    const key = targetSignatureKey(sig);
    const cached = res._pipelines.get(key);
    if (cached) {
        return cached;
    }
    const device = engine._device;
    const formats = (sig as RenderTargetSignature & { _colorFormats?: readonly GPUTextureFormat[] })._colorFormats ?? (sig._colorFormat ? [sig._colorFormat] : []);
    if (formats.length === 0) {
        throw new Error("pbr-geometry: render target has no color attachments");
    }
    const alphaBlend = res._alphaBlend;
    const blendState: GPUBlendState | undefined = alphaBlend
        ? {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          }
        : undefined;
    const colorTargets: GPUColorTargetState[] = formats.map((fmt) => (blendState ? { format: fmt, blend: blendState } : { format: fmt }));
    const sourceFeatures = (view.source as PbrMaterialProps)._renderFeatures?.features ?? 0;
    const hasDoubleSided = (sourceFeatures & PBR_HAS_DOUBLE_SIDED) !== 0;
    const cullMode = hasDoubleSided ? "none" : view._reverseCulling ? "front" : "back";
    const pipeline = device.createRenderPipeline({
        layout: res._pipelineLayout,
        vertex: { module: res._vertModule, entryPoint: "main", buffers: res._composed._vertexBufferLayouts },
        fragment: { module: res._fragModule, entryPoint: "main", targets: colorTargets },
        depthStencil: sig._depthStencilFormat
            ? {
                  format: sig._depthStencilFormat,
                  depthCompare: sig._depthCompare ?? REVERSE_DEPTH_COMPARE,
                  // Disable depth-write for alpha-blended meshes so background
                  // depth survives partially-transparent pixels. Matches the
                  // Standard geometry-renderable behaviour.
                  depthWriteEnabled: !alphaBlend,
              }
            : undefined,
        multisample: { count: sig._sampleCount },
        primitive: { topology: "triangle-list", cullMode, frontFace: "ccw" },
    });
    res._pipelines.set(key, pipeline);
    return pipeline;
}

// ─── Helpers cribbed from pbr-renderable (no static cycle) ─────────────

function _getPackedSingleLightType(lights: SceneContext["lights"], packedIndex: number): "hemispheric" | "directional" | "spot" | "point" {
    let packed = 0;
    for (const light of lights) {
        if (!light._writeLightUbo) {
            continue;
        }
        if (packed === packedIndex) {
            const t = light.lightType;
            return t === "hemispheric" || t === "directional" || t === "spot" ? t : "point";
        }
        packed++;
    }
    return "point";
}

/** Writes material UBO via the helper exported from pbr-renderable. */
function _writePbrMaterialData(data: Float32Array, mat: PbrMaterialProps, spec: import("../../shader/fragment-types.js").UboSpec): void {
    _writeMaterialData(data, mat, spec);
}
