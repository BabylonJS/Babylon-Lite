/** Standard geometry-MRT renderable factory.
 *
 *  Builds a {@link Renderable} that draws a single mesh through a
 *  {@link createStandardGeometryMaterialView} into the geometry renderer
 *  task's multi-attachment render target. Mirrors the regular
 *  {@link buildStandardMeshRenderables} structure (rebuildSingle closure
 *  → Renderable.bind() → DrawBinding.update/draw) so that per-mesh
 *  bind groups, mesh UBO refreshes (including writeMeshLightSelection),
 *  and material UBO version tracking flow through the exact same
 *  contract scenes already use for ordinary Standard renderables.
 *
 *  Feature parity with {@link buildStandardMeshRenderables}: thin
 *  instances (matrix + optional per-instance colour), bound-texture
 *  acquire/release lifecycle, sort-centre tracking for transparency
 *  ordering. Shadows are intentionally excluded — the geometry pass
 *  writes raw G-buffer attachments, not shaded colour.
 *
 *  Per-(view, mesh-feature-variant) shared state — composed shader,
 *  mesh BGL, pipeline cache — is cached on `view._geometry` keyed by
 *  the mesh-feature bits that affect shader composition (thin-instance
 *  matrix / colour). Per-mesh state (UBOs, bind group, sort centre)
 *  lives in the closure returned by {@link buildStandardGeometryRenderable}.
 *
 *  This module is imported only by {@link createStandardGeometryMaterialView}
 *  — scenes that do not use the geometry renderer task pay zero bytes for it.
 */

import { F32 } from "../../engine/typed-arrays.js";
import type { EngineContext } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshGroupBuilder, Renderable } from "../../render/renderable.js";
import { writeMeshLightSelection } from "../../render/lights-ubo.js";
import type { SceneContext } from "../../scene/scene-core.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import { acquireTexture, releaseTexture } from "../../resource/gpu-pool.js";
import type { ComposedShader, ShaderFragment } from "../../shader/fragment-types.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import { createThinInstanceFragment } from "../../shader/fragments/thin-instance-fragment.js";
import { syncThinInstanceBuffers } from "../../mesh/thin-instance-gpu.js";

import type { Material } from "../material.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { _getStdExtsSorted, DOUBLE_SIDED, HAS_DIFFUSE_TEXTURE, HAS_OPACITY_TEXTURE, NEEDS_UV, NEEDS_UV2 } from "./standard-flags.js";
import { writeStdMaterialData, _isStandardUvOffsetEnabled } from "./standard-pipeline.js";
import { composeStandardGeometryShader } from "./standard-geometry-output-shader.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { collectStdBoundTextures } from "./collect-std-bound-textures.js";
import { _computeMeshFeatures, MSH_HAS_INSTANCE_COLOR, MSH_HAS_THIN_INSTANCES } from "../mesh-features.js";
import type { StandardGeometryMaterialView } from "./geometry-view.js";

/** Lazily-created singleton {@link MeshGroupBuilder} that geometry views point at
 *  via their overridden `_buildGroup`. The async builder body is unreachable —
 *  geometry views are dispatched per-mesh via {@link RenderTask.addMesh} which calls
 *  `_rebuildSingle` directly. Centralizing the per-mesh factory here means
 *  `resolvePendingMeshes` doesn't need any view-aware branching. Lazy-init keeps the
 *  module free of top-level side effects so an unused geometry path tree-shakes away. */
let _standardGeometryGroupBuilder: MeshGroupBuilder | null = null;
export function getStandardGeometryGroupBuilder(): MeshGroupBuilder {
    if (_standardGeometryGroupBuilder) {
        return _standardGeometryGroupBuilder;
    }
    const builder = (async () => {
        throw new Error("standard-geometry view does not support scene group building");
    }) as MeshGroupBuilder;
    builder._materialFamily = "standard";
    builder._rebuildSingle = (scene: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable => {
        const view = (materialOverride ?? mesh.material) as StandardGeometryMaterialView;
        return buildStandardGeometryRenderable(scene, mesh, view);
    };
    return (_standardGeometryGroupBuilder = builder);
}

/** Per-(task, source-material, mesh-variant) shared resources lazily attached
 *  to the view. Cached on `view._geometry` (Map keyed by mesh-variant bits) to
 *  keep the same WGSL + BGL + pipeline objects across all meshes that share
 *  the view and the same shader-relevant mesh features. */
interface StandardGeometryViewResources {
    _composed: ComposedShader;
    _features: number;
    _meshBGL: GPUBindGroupLayout;
    _pipelineLayout: GPUPipelineLayout;
    _vertModule: GPUShaderModule;
    _fragModule: GPUShaderModule;
    _pipelines: Map<string, GPURenderPipeline>;
    /** Ext fragments that contributed bindings — used by per-mesh bind groups. */
    _extFragments: readonly { _ext: ReturnType<typeof _getStdExtsSorted>[number] }[];
    _alphaBlend: boolean;
    /** Shared material UBO and dirty-version state (one per source material in this view). */
    _matUBO: GPUBuffer;
    _matData: Float32Array;
    _lastUboVersion: number;
    /** Optional UV-transform UBO. Allocated when the view's features include NEEDS_UV. */
    _upUBO: GPUBuffer | null;
}

/** Pack the mesh-feature bits that change shader composition / pipeline
 *  into a 2-bit variant key. At most 4 variants per view in the worst case. */
function _variantKey(meshFeatures: number): number {
    let k = 0;
    if (meshFeatures & MSH_HAS_THIN_INSTANCES) {
        k |= 1;
    }
    if (meshFeatures & MSH_HAS_INSTANCE_COLOR) {
        k |= 2;
    }
    return k;
}

/** Build a {@link Renderable} for one mesh drawn through a Standard geometry view.
 *  Reuses or creates per-(view, mesh-variant) shared resources on `view._geometry`. */
export function buildStandardGeometryRenderable(scene: SceneContext, mesh: Mesh, view: StandardGeometryMaterialView): Renderable {
    const engine = scene.surface.engine;
    const device = engine._device;
    const source = view.source as StandardMaterialProps;
    // Geometry pass has no receiver path — pass receiveShadows=false.
    const meshFeatures = _computeMeshFeatures(mesh, false);
    const variantKey = _variantKey(meshFeatures);
    const res = _ensureViewResources(view, engine, meshFeatures, variantKey);
    const features = res._features;

    // Per-mesh UBOs + bind group.
    const meshUboData = new F32(res._composed._meshUboSpec._totalBytes / 4);
    meshUboData.set(mesh.worldMatrix, 0);
    writeMeshLightSelection(mesh, scene.lights, meshUboData);
    const meshUBO = createUniformBuffer(engine, meshUboData);

    const bg = _createGeometryMeshBindGroup(engine, view, res, mesh, meshUBO);

    // Acquire all textures the standard shader references so the GPU-pool
    // doesn't release them while the geometry pass holds bind groups on
    // them. Mirrors standard-renderable's lifecycle exactly.
    const boundTextures = collectStdBoundTextures(source);
    for (const t of boundTextures) {
        acquireTexture(t);
    }
    const prevDisposables = (scene as SceneContext)._meshDisposables.get(mesh) ?? [];
    (scene as SceneContext)._meshDisposables.set(mesh, [
        ...prevDisposables,
        () => {
            for (const t of boundTextures) {
                releaseTexture(t);
            }
        },
    ]);

    let _lastWorldVersion = mesh.worldMatrixVersion;
    let _lastLightsCount = scene.lights.length;

    const needsUV = (features & NEEDS_UV) !== 0;
    const needsUV2 = (features & NEEDS_UV2) !== 0;
    const isAlphaBlend = res._alphaBlend;
    const hasThinInstances = (meshFeatures & MSH_HAS_THIN_INSTANCES) !== 0;
    const hasInstanceColor = (meshFeatures & MSH_HAS_INSTANCE_COLOR) !== 0;
    const sortCenter = [mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!] as [number, number, number];

    const update = (): void => {
        if (mesh.worldMatrixVersion !== _lastWorldVersion || scene.lights.length !== _lastLightsCount) {
            sortCenter[0] = mesh.worldMatrix[12]!;
            sortCenter[1] = mesh.worldMatrix[13]!;
            sortCenter[2] = mesh.worldMatrix[14]!;
            meshUboData.set(mesh.worldMatrix, 0);
            writeMeshLightSelection(mesh, scene.lights, meshUboData);
            device.queue.writeBuffer(meshUBO, 0, meshUboData as Float32Array<ArrayBuffer>);
            _lastWorldVersion = mesh.worldMatrixVersion;
            _lastLightsCount = scene.lights.length;
        }
        if (source._uboVersion !== res._lastUboVersion) {
            res._lastUboVersion = source._uboVersion;
            const textureLevel = (features & HAS_DIFFUSE_TEXTURE) !== 0 ? 1.0 : 0.0;
            res._matData.fill(0);
            writeStdMaterialData(res._matData, source, textureLevel);
            device.queue.writeBuffer(res._matUBO, 0, res._matData.buffer, 0, 96);
        }
    };

    const draw = (pass: GPURenderPassEncoder | GPURenderBundleEncoder): number => {
        if (mesh.visible === false) {
            return 0;
        }
        pass.setBindGroup(1, bg);
        const g = (mesh as Mesh)._gpu;
        let slot = 0;
        pass.setVertexBuffer(slot++, g.positionBuffer);
        pass.setVertexBuffer(slot++, g.normalBuffer);
        if (needsUV && g.uvBuffer) {
            pass.setVertexBuffer(slot++, g.uvBuffer);
        }
        if (needsUV2 && g.uv2Buffer) {
            pass.setVertexBuffer(slot++, g.uv2Buffer);
        }
        const ti = hasThinInstances ? mesh.thinInstances : null;
        if (ti) {
            slot = syncThinInstanceBuffers(engine, ti, pass, slot, hasInstanceColor);
        }
        pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
        if (ti && ti.count > 0) {
            pass.drawIndexed(g.indexCount, ti.count);
        } else {
            pass.drawIndexed(g.indexCount);
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

// ─── Shared per-view resources ─────────────────────────────────────────────

function _ensureViewResources(view: StandardGeometryMaterialView, engine: EngineContext, meshFeatures: number, variantKey: number): StandardGeometryViewResources {
    let cache = view._geometry as Map<number, StandardGeometryViewResources> | undefined;
    if (!cache) {
        cache = new Map();
        Object.defineProperty(view, "_geometry", { value: cache, enumerable: false, configurable: true });
    }
    const cached = cache.get(variantKey);
    if (cached) {
        return cached;
    }
    const source = view.source as StandardMaterialProps;
    const features = view._renderFeatures.features;

    // Collect the same ext fragments the regular Standard renderable would —
    // bump, opacity, specular, … — so the shared shader code is identical.
    const sortedExts = _getStdExtsSorted();
    const frags: ShaderFragment[] = [];
    const usedExts: { _ext: (typeof sortedExts)[number] }[] = [];
    for (const ext of sortedExts) {
        if (features & ext._feature) {
            const f = ext._frag(features);
            if (f) {
                frags.push(f);
                usedExts.push({ _ext: ext });
            }
        }
    }

    // Thin instances. Mirror standard-renderable: when per-instance colour is
    // present we override the fragment's AT slot with a BC slot that
    // multiplies the final lit `color` (only consumed when `emitColor` is on
    // — otherwise WGSL folds the dead code).
    if (meshFeatures & MSH_HAS_THIN_INSTANCES) {
        const hasColor = (meshFeatures & MSH_HAS_INSTANCE_COLOR) !== 0;
        const tiFrag = createThinInstanceFragment(hasColor);
        if (hasColor) {
            const { _fragmentSlots: _drop, ...rest } = tiFrag;
            frags.push({
                ...rest,
                _fragmentSlots: {
                    BC: `color = vec4<f32>(color.rgb * input.vInstanceColor.rgb, color.a * input.vInstanceColor.a);`,
                },
            });
        } else {
            frags.push(tiFrag);
        }
    }

    const composed = composeStandardGeometryShader(features, meshFeatures, frags, view._geometryAttachments, "", view._emitColor);
    const device = engine._device;
    const meshBGL = device.createBindGroupLayout(composed._meshBGLDescriptor);
    // Pipeline layout: scene BG (group 0) + mesh BG (group 1). Geometry pass
    // has no shadow receiver group.
    const sceneBGL = getSceneBindGroupLayout(engine);
    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [sceneBGL, meshBGL],
    });
    const vertModule = device.createShaderModule({ code: composed._vertexWGSL });
    const fragModule = device.createShaderModule({ code: composed._fragmentWGSL });

    // Re-detect alpha-blend from the *source* material — the view masked it
    // out so the composer doesn't emit standard's source-over color blend.
    const alphaBlend = source.alpha < 1 || (features & HAS_OPACITY_TEXTURE) !== 0;

    // Shared material UBO (one per source material per view). All meshes of
    // this material reuse the same UBO; updates are version-guarded.
    const matData = new F32(24);
    const textureLevel = (features & HAS_DIFFUSE_TEXTURE) !== 0 ? 1.0 : 0.0;
    writeStdMaterialData(matData, source, textureLevel);
    const matUBO = createUniformBuffer(engine, matData);

    // UV transform UBO when the vertex stage emits UV math.
    let upUBO: GPUBuffer | null = null;
    if ((features & NEEDS_UV) !== 0) {
        const uvData = new F32(4);
        let scaleX = 1;
        let scaleY = 1;
        let offsetX = 0;
        let offsetY = 0;
        if ((features & HAS_DIFFUSE_TEXTURE) !== 0 && source.diffuseTexture) {
            scaleX = source.uvScale[0];
            scaleY = source.uvScale[1];
            // UV offset folds to 0 unless a loader/scene opted in via enableStandardUvOffset.
            if (_isStandardUvOffsetEnabled()) {
                offsetX = source.uvOffset![0];
                offsetY = source.uvOffset![1];
            }
            if (source.diffuseTexture.invertY) {
                offsetY += scaleY;
                scaleY = -scaleY;
            }
        } else if ((features & HAS_OPACITY_TEXTURE) !== 0 && source.opacityTexture?.invertY) {
            offsetY = 1;
            scaleY = -1;
        } else if (source.bumpTexture?.invertY) {
            offsetY = 1;
            scaleY = -1;
        }
        uvData[0] = scaleX;
        uvData[1] = scaleY;
        uvData[2] = offsetX;
        uvData[3] = offsetY;
        upUBO = createUniformBuffer(engine, uvData);
    }

    const res: StandardGeometryViewResources = {
        _composed: composed,
        _features: features,
        _meshBGL: meshBGL,
        _pipelineLayout: pipelineLayout,
        _vertModule: vertModule,
        _fragModule: fragModule,
        _pipelines: new Map(),
        _extFragments: usedExts,
        _alphaBlend: alphaBlend,
        _matUBO: matUBO,
        _matData: matData,
        _lastUboVersion: source._uboVersion,
        _upUBO: upUBO,
    };
    cache.set(variantKey, res);
    return res;
}

function _createGeometryMeshBindGroup(engine: EngineContext, view: StandardGeometryMaterialView, res: StandardGeometryViewResources, mesh: Mesh, meshUBO: GPUBuffer): GPUBindGroup {
    const source = view.source as StandardMaterialProps;
    const features = res._features;
    let nextBinding = 0;
    const entries: GPUBindGroupEntry[] = [
        { binding: nextBinding++, resource: { buffer: meshUBO } },
        { binding: nextBinding++, resource: { buffer: res._matUBO } },
    ];
    if ((features & HAS_DIFFUSE_TEXTURE) !== 0 && source.diffuseTexture) {
        const tex = source.diffuseTexture;
        entries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }
    if ((features & NEEDS_UV) !== 0 && res._upUBO) {
        entries.push({ binding: nextBinding++, resource: { buffer: res._upUBO } });
    }
    for (const used of res._extFragments) {
        if (used._ext._bind) {
            // Geometry-output features never OR in the skeleton/vcolor exts (those are color-pass
            // only), so `mesh` is forwarded only for signature parity; texture exts ignore it.
            nextBinding = used._ext._bind(source, entries, nextBinding, mesh);
        }
    }
    // Geometry-params `gp` UBO is contributed by the geometry composer as the
    // last fragment, so its binding is appended last. Present iff the
    // requested attachments need it (LINEAR_VELOCITY or NORMALIZED_VIEW_DEPTH).
    if (view._gpUBO) {
        entries.push({ binding: nextBinding++, resource: { buffer: view._gpUBO } });
    }
    return engine._device.createBindGroup({ layout: res._meshBGL, entries });
}

function _getOrCreateGeometryPipeline(
    engine: EngineContext,
    sig: RenderTargetSignature,
    view: StandardGeometryMaterialView,
    res: StandardGeometryViewResources
): GPURenderPipeline {
    const key = targetSignatureKey(sig);
    const cached = res._pipelines.get(key);
    if (cached) {
        return cached;
    }
    const device = engine._device;
    const formats = (sig as RenderTargetSignature & { _colorFormats?: readonly GPUTextureFormat[] })._colorFormats ?? (sig._colorFormat ? [sig._colorFormat] : []);
    if (formats.length === 0) {
        throw new Error("standard-geometry: render target has no color attachments");
    }
    const alphaBlend = res._alphaBlend;
    const blendState: GPUBlendState | undefined = alphaBlend
        ? {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          }
        : undefined;
    const colorTargets: GPUColorTargetState[] = formats.map((fmt) => (blendState ? { format: fmt, blend: blendState } : { format: fmt }));
    const cullMode = (res._features & DOUBLE_SIDED) !== 0 ? "none" : view._reverseCulling ? "front" : "back";
    const pipeline = device.createRenderPipeline({
        layout: res._pipelineLayout,
        vertex: { module: res._vertModule, entryPoint: "main", buffers: res._composed._vertexBufferLayouts },
        fragment: { module: res._fragModule, entryPoint: "main", targets: colorTargets },
        depthStencil: sig._depthStencilFormat
            ? {
                  format: sig._depthStencilFormat,
                  depthCompare: sig._depthCompare ?? "greater-equal",
                  // BJS disables depth-write for transparent/opacity meshes in the
                  // geometry pass so background depth survives partially-transparent pixels.
                  depthWriteEnabled: !alphaBlend,
              }
            : undefined,
        multisample: { count: sig._sampleCount },
        // Geometry MRT renders to offscreen targets, so it needs the same
        // Render upright — front face is always "ccw".
        primitive: { topology: "triangle-list", cullMode, frontFace: "ccw" },
    });
    res._pipelines.set(key, pipeline);
    return pipeline;
}
