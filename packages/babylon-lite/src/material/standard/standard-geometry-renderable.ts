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
import type { MeshGroupBuilder, MeshRebuildResources, Renderable } from "../../render/renderable.js";
import { writeMeshLightSelection } from "../../render/mesh-light-selection.js";
import type { SceneContext } from "../../scene/scene-core.js";
import { createUniformBuffer } from "../../resource/uniform-buffer.js";
import { acquireTexture } from "../../resource/texture-acquire.js";
import { releaseTexture } from "../../resource/texture-release.js";
import type { ComposedShader, ShaderFragment } from "../../shader/fragment-types.js";
import { targetSignatureKey } from "../../engine/render-target-signature.js";
import { GeometryTextureType } from "../../frame-graph/geometry-types.js";
import { packMat4IntoF32 } from "../../math/pack-mat4-into-f32.js";

import type { Material } from "../material.js";
import type { StandardMaterialProps } from "./standard-material.js";
import {
    _getStdExtsSorted,
    _stdMaterialVariantKey,
    DOUBLE_SIDED,
    HAS_DIFFUSE_TEXTURE,
    HAS_OPACITY_TEXTURE,
    HAS_SKELETON,
    MATERIAL_ALPHA_BLEND,
    NEEDS_UV,
    NEEDS_UV2,
    VERTEX_ALPHA,
} from "./standard-flags.js";
import type { StdExt } from "./standard-flags.js";
import { isStandardUvInverted, writeStandardUvTransformData, writeStdMaterialData, _stdVertexColorFragment } from "./standard-pipeline.js";
import { composeStandardGeometryShader } from "./standard-geometry-output-shader.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { collectStdBoundTextures } from "./collect-std-bound-textures.js";
import { _computeMeshFeatures, MSH_HAS_INSTANCE_COLOR, MSH_HAS_MORPH_TARGETS, MSH_HAS_THIN_INSTANCES, MSH_HAS_VERTEX_COLOR } from "../mesh-features.js";
import { _getStandardGeometrySkeletonVelocityFactory, _getStandardGeometryThinInstanceHelpers } from "./geometry-view.js";
import type { StandardGeometryMaterialView } from "./geometry-view.js";
import type { StandardGeometryContext } from "./standard-renderable.js";
import { wgsl } from "../../shader/wgsl.js";
import { drawMeshIndexed } from "../../mesh/mesh-vertex-layout.js";

/** Lazily-created singleton {@link MeshGroupBuilder} that geometry views point at
 *  via their overridden `_buildGroup`. The async builder body is unreachable —
 *  geometry views are dispatched per-mesh via `addMeshToTask`, which calls
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
    builder._sceneIndependentRebuild = true;
    builder._rebuildSingle = (scene: SceneContext, mesh: Mesh, materialOverride?: Material, resources?: MeshRebuildResources): Renderable => {
        const view = (materialOverride ?? mesh.material) as StandardGeometryMaterialView;
        if (!resources) {
            throw new Error("standard-geometry rebuild requires task-owned resources");
        }
        return buildStandardGeometryRenderable(scene, mesh, view, resources);
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
    _meshFeatures: number;
    _sceneFeatures: number;
    _meshBGL: GPUBindGroupLayout;
    _pipelineLayout: GPUPipelineLayout;
    _vertModule: GPUShaderModule;
    _fragModule: GPUShaderModule;
    _pipelines: Map<string, GPURenderPipeline>;
    /** Ext fragments that contributed bindings — used by per-mesh bind groups. */
    _extFragments: readonly { _ext: ReturnType<typeof _getStdExtsSorted>[number] }[];
    _vertexBufferBinders: readonly NonNullable<StdExt["_bindVertexBuffers"]>[];
    _needsVelocity: boolean;
    _hasSkeletonVelocity: boolean;
    _alphaBlend: boolean;
    /** Shared material UBO and dirty-version state (one per source material in this view). */
    _matUBO: GPUBuffer;
    _matData: Float32Array;
    _lastUboVersion: number;
    /** Optional UV-transform UBO. Allocated when the view's features include NEEDS_UV. */
    _upUBO: GPUBuffer | null;
    /** Renderable/task entries currently retaining this cached variant. */
    _owners: number;
}

/** Mirrored-mesh front-face resolution for the geometry pass. Installed only by
 *  `std-mirrored-support`, i.e. the `enableMirroredMeshes()` opt-in — the glTF loader's built-in
 *  winding pass never reaches Standard materials. Module-local with a single exported setter: when
 *  the opt-in is absent the setter tree-shakes, the bundler proves this is always null, and the
 *  `frontFace` ternary below folds to the plain `"ccw"` literal — unmirrored geometry scenes stay
 *  byte-identical.
 *  @internal */
let _geometryWinding: ((meshFeatures: number) => GPUFrontFace) | null = null;
/** @internal Install geometry-pass winding resolution. */
export function _installStdGeometryWinding(resolve: (meshFeatures: number) => GPUFrontFace): void {
    _geometryWinding = resolve;
}

function _variantKey(features: number, meshFeatures: number, sceneFeatures: number, meshVertexKey: string): string {
    return `${features}:${meshFeatures}:${sceneFeatures}${meshVertexKey}`;
}

/** Build a {@link Renderable} for one mesh drawn through a Standard geometry view.
 *  Reuses or creates per-(view, mesh-variant) shared resources on `view._geometry`. */
export function buildStandardGeometryRenderable(scene: SceneContext, mesh: Mesh, view: StandardGeometryMaterialView, resources: MeshRebuildResources): Renderable {
    const engine = scene.surface.engine;
    const device = engine._device;
    const source = view.source as StandardMaterialProps;
    const standardContext = (scene as SceneContext & { _standardGeometryContext?: StandardGeometryContext })._standardGeometryContext;
    // Geometry pass has no receiver path — pass receiveShadows=false.
    const meshFeatures = _computeMeshFeatures(mesh, false);
    let features = view._renderFeatures.features;
    const sortedExts = _getStdExtsSorted();
    for (const ext of sortedExts) {
        features |= ext._meshFeatures?.(meshFeatures, source) ?? 0;
    }
    const sceneFeatures = standardContext?.sceneShader?._features ?? 0;
    // Vertex colour is enabled through the canonical `enableStandardVertexColors()`
    // seam (master #430). RGB is always applied; the vertex-alpha opt-in below is
    // layered on top.
    const hasVertexColor = !!_stdVertexColorFragment && (meshFeatures & MSH_HAS_VERTEX_COLOR) !== 0;
    // Explicit vertex-alpha (Babylon `mesh.hasVertexAlpha`): opt-in translucency
    // driven by the RGBA vertex-colour buffer. Set VERTEX_ALPHA so the composed
    // Standard fragment consumes `vColor.a` (alpha + alpha mask) and fold in
    // MATERIAL_ALPHA_BLEND so the geometry pipeline source-over blends, disables
    // depth-write, keys a distinct cached variant, and classifies the mesh into the
    // transparent phase. RGB vertex colour is applied regardless of this opt-in.
    if (hasVertexColor && mesh.hasVertexAlpha === true) {
        features |= VERTEX_ALPHA | MATERIAL_ALPHA_BLEND;
    }
    const variantKey = _variantKey(features, meshFeatures, sceneFeatures, mesh._gpu._vbKey ?? "") + (_stdMaterialVariantKey?.(source) ?? "");
    const res = _ensureViewResources(view, engine, meshFeatures, features, sceneFeatures, variantKey, standardContext, mesh._gpu._vbLayout);
    _retainViewResources(view, variantKey, res, resources);

    // Per-mesh UBOs + bind group.
    const meshUboData = new F32(res._composed._meshUboSpec._totalBytes / 4);
    // Floating-origin offset + invalidation must key off the EFFECTIVE task camera:
    // a geometry task can render with a `config.camera` override whose origin (and
    // view-projection) differs from `scene.camera`. Packing the world/previous-world
    // against `scene.camera` while the task's view-projection uses the override would
    // desync the origins and corrupt both position and velocity. `view._camera`
    // carries the override (a stable ref whose worldMatrix reads live); fall back to
    // the real scene when the task uses the scene's active camera.
    const foScene = view._camera ? ({ camera: view._camera } as SceneContext) : scene;
    const _packMeshWorld = engine._makePackMeshWorld?.(foScene) ?? packMat4IntoF32;
    _packMeshWorld(meshUboData, mesh.worldMatrix, 0, 0);
    writeMeshLightSelection(mesh, scene.lights, meshUboData);
    const previousWorldOffset = res._composed._meshUboSpec._offsets.get("previousWorld");
    const velocityEnabledOffset = res._composed._meshUboSpec._offsets.get("velocityEnabled");
    // Previous-world tracks the mesh world matrix relative to the origin that
    // was current when it was captured (the same offset applied to the current
    // world above). In floating-origin mode `gp.previousViewProjection` is
    // baked relative to that frame's camera origin, so the previous world MUST
    // be origin-relative to the *same* frame — an absolute previous world would
    // mismatch the origin-relative previous view-projection and corrupt both
    // the reprojected position and the resulting velocity. `_packMeshWorld`
    // subtracts the live floating-origin offset (identity for non-LWR engines).
    const previousWorld = res._needsVelocity ? new F32(16) : null;
    if (previousWorld) {
        _packMeshWorld(previousWorld, mesh.worldMatrix, 0, 0);
    }
    if (previousWorldOffset !== undefined) {
        meshUboData.set(previousWorld!, previousWorldOffset / 4);
    }
    if (velocityEnabledOffset !== undefined) {
        meshUboData[velocityEnabledOffset / 4] = 0;
    }
    const skeletonVelocityFactory = res._hasSkeletonVelocity ? _getStandardGeometrySkeletonVelocityFactory() : null;
    const meshUBO = createUniformBuffer(engine, meshUboData);
    const bindingDisposers: (() => void)[] = [];
    let skeletonVelocity: ReturnType<NonNullable<typeof skeletonVelocityFactory>> | null = null;
    let boundTextures: ReturnType<typeof collectStdBoundTextures> = [];
    let _perMeshDisposed = false;
    const _disposePerMesh = (): void => {
        if (_perMeshDisposed) {
            return;
        }
        _perMeshDisposed = true;
        meshUBO.destroy();
        skeletonVelocity?._dispose();
        for (const dispose of bindingDisposers) {
            dispose();
        }
        for (const t of boundTextures) {
            releaseTexture(t);
        }
    };
    resources._lifetimeDisposers.push(_disposePerMesh);

    if (res._hasSkeletonVelocity && (!mesh.skeleton || !skeletonVelocityFactory)) {
        throw new Error("standard-geometry: skeletal velocity feature was not preloaded");
    }
    // Acquire all textures the standard shader references so the GPU-pool
    // doesn't release them while the geometry pass holds bind groups on
    // them. Mirrors standard-renderable's lifecycle exactly.
    boundTextures = collectStdBoundTextures(source);
    for (const t of boundTextures) {
        acquireTexture(t);
    }
    skeletonVelocity =
        skeletonVelocityFactory && mesh.skeleton
            ? skeletonVelocityFactory(engine, mesh.skeleton, (texture) => _createGeometryMeshBindGroup(scene, view, res, mesh, meshUBO, texture, bindingDisposers))
            : null;
    let meshBindGroup = skeletonVelocity?._bindGroup ?? _createGeometryMeshBindGroup(scene, view, res, mesh, meshUBO, null, bindingDisposers);
    let velocityReady = false;

    let _lastWorldVersion = mesh.worldMatrixVersion;
    let _lastLightsCount = scene.lights.length;

    const needsUV = (features & NEEDS_UV) !== 0;
    const needsUV2 = (features & NEEDS_UV2) !== 0;
    const isAlphaBlend = res._alphaBlend;
    const hasThinInstances = (meshFeatures & MSH_HAS_THIN_INSTANCES) !== 0;
    const hasInstanceColor = (meshFeatures & MSH_HAS_INSTANCE_COLOR) !== 0;
    // Thin-instance helpers are dynamically injected by `preloadStandardGeometryFeatures`
    // only when a geometry-pass mesh actually carries thin instances, so non-thin
    // geometry scenes retain zero thin-instance bytes. Resolve once at build time.
    const tiHelpers = hasThinInstances ? _getStandardGeometryThinInstanceHelpers() : null;
    if (hasThinInstances && !tiHelpers) {
        throw new Error("standard-geometry: thin instances were not preloaded");
    }
    const sortCenter = [mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!] as [number, number, number];
    let thinDrawArgs: GPUBuffer | null = null;

    const _baseUpdate = (): void => {
        const velocityEnabled = res._needsVelocity && velocityReady && !view._velocityExclusions?.has(mesh);
        if (mesh.worldMatrixVersion !== _lastWorldVersion || scene.lights.length !== _lastLightsCount || previousWorldOffset !== undefined || velocityEnabledOffset !== undefined) {
            sortCenter[0] = mesh.worldMatrix[12]!;
            sortCenter[1] = mesh.worldMatrix[13]!;
            sortCenter[2] = mesh.worldMatrix[14]!;
            _packMeshWorld(meshUboData, mesh.worldMatrix, 0, 0);
            writeMeshLightSelection(mesh, scene.lights, meshUboData);
            if (previousWorldOffset !== undefined) {
                meshUboData.set(previousWorld!, previousWorldOffset / 4);
            }
            if (velocityEnabledOffset !== undefined) {
                meshUboData[velocityEnabledOffset / 4] = velocityEnabled ? 1 : 0;
            }
            device.queue.writeBuffer(meshUBO, 0, meshUboData as Float32Array<ArrayBuffer>);
            _lastWorldVersion = mesh.worldMatrixVersion;
            _lastLightsCount = scene.lights.length;
        }
        if (skeletonVelocity) {
            meshBindGroup = skeletonVelocity._update();
        }
        if (previousWorld) {
            // Snapshot the current world relative to the *current* origin so next
            // frame's previous-world matches next frame's previous view-projection.
            _packMeshWorld(previousWorld, mesh.worldMatrix, 0, 0);
            velocityReady = true;
        }
        if (source._uboVersion !== res._lastUboVersion) {
            res._lastUboVersion = source._uboVersion;
            const textureLevel = (features & HAS_DIFFUSE_TEXTURE) !== 0 ? 1.0 : 0.0;
            res._matData.fill(0);
            writeStdMaterialData(res._matData, source, textureLevel);
            device.queue.writeBuffer(res._matUBO, 0, res._matData.buffer, 0, 96);
        }
        const ti = hasThinInstances ? mesh.thinInstances : null;
        if (ti) {
            thinDrawArgs = tiHelpers!._syncForDraw(engine, ti, hasInstanceColor, mesh._gpu);
        }
    };
    // Floating-origin: the mesh UBO bakes the active-camera offset into the
    // world (and previous-world) translation, so a camera move alone makes the
    // UBO stale even when the mesh never moved. `_wrapRenderableForFO` forces a
    // re-pack on camera-version change (identity/undefined for non-LWR engines).
    // Keyed off the EFFECTIVE task camera (`foScene`) so a `config.camera` override
    // invalidates consistently with the origin its matrices are packed against.
    const _invalidate = (): void => {
        _lastWorldVersion = -1;
    };
    const update = engine._wrapRenderableForFO?.(_baseUpdate, foScene, _invalidate) ?? _baseUpdate;

    const draw = (pass: GPURenderPassEncoder | GPURenderBundleEncoder): number => {
        if (mesh.visible === false) {
            return 0;
        }
        pass.setBindGroup(1, meshBindGroup);
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
        for (const bindVertexBuffers of res._vertexBufferBinders) {
            slot = bindVertexBuffers(mesh, pass, slot);
        }
        if (hasVertexColor) {
            pass.setVertexBuffer(slot++, g.colorBuffer!);
        }
        const ti = hasThinInstances ? mesh.thinInstances : null;
        if (ti) {
            slot = tiHelpers!._syncBuffers(engine, ti, pass, slot, hasInstanceColor);
        }
        pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
        if (ti && thinDrawArgs) {
            pass.drawIndexedIndirect(thinDrawArgs, 0);
        } else {
            drawMeshIndexed(pass, g, ti?.count);
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

function _ensureViewResources(
    view: StandardGeometryMaterialView,
    engine: EngineContext,
    meshFeatures: number,
    features: number,
    sceneFeatures: number,
    variantKey: string,
    standardContext: StandardGeometryContext | undefined,
    meshVertexLayout?: Mesh["_gpu"]["_vbLayout"]
): StandardGeometryViewResources {
    let cache = view._geometry as Map<string, StandardGeometryViewResources> | undefined;
    if (!cache) {
        cache = new Map();
        Object.defineProperty(view, "_geometry", { value: cache, enumerable: false, configurable: true });
    }
    const cached = cache.get(variantKey);
    if (cached) {
        return cached;
    }
    const source = view.source as StandardMaterialProps;

    // Collect the same ext fragments the regular Standard renderable would —
    // bump, opacity, specular, … — so the shared shader code is identical.
    const sortedExts = _getStdExtsSorted();
    const frags: ShaderFragment[] = [];
    const usedExts: { _ext: (typeof sortedExts)[number] }[] = [];
    const vertexBufferBinders: NonNullable<StdExt["_bindVertexBuffers"]>[] = [];
    // Keep morph first; an active UV-transform extension is the second
    // post-composer. composeStandardShader applies those two reserved slots.
    if ((meshFeatures & MSH_HAS_MORPH_TARGETS) !== 0) {
        const morphFragment = standardContext?.morphFragment;
        if (!morphFragment) {
            throw new Error("standard-geometry: morph targets require the scene Standard morph context");
        }
        frags.push(morphFragment());
    }
    for (const ext of sortedExts) {
        if (features & ext._feature) {
            const f = ext._frag(features, meshFeatures, source);
            if (f) {
                frags.push(f);
                usedExts.push({ _ext: ext });
            }
            if (ext._bindVertexBuffers) {
                vertexBufferBinders.push(ext._bindVertexBuffers);
            }
        }
    }
    // Vertex colour via the canonical `enableStandardVertexColors()` seam, appended
    // AFTER the ext loop: its opt-in alpha-test reads the diffuse sample `_ds` that the
    // diffuse ext defines in its own AT slot, so the vertex-colour AT slot must follow.
    // Its `color` vertex attribute therefore follows the ext (skeleton) attributes, and
    // the draw closure binds `colorBuffer` after the ext vertex-buffer binders. RGB is
    // always applied; alpha + alpha-test only under the VERTEX_ALPHA opt-in.
    if (_stdVertexColorFragment && (meshFeatures & MSH_HAS_VERTEX_COLOR) !== 0) {
        frags.push(_stdVertexColorFragment((features & HAS_DIFFUSE_TEXTURE) !== 0, (features & VERTEX_ALPHA) !== 0));
    }

    // Thin instances. Mirror standard-renderable: when per-instance colour is
    // present we override the fragment's AT slot with a BC slot that
    // multiplies the final lit `color` (only consumed when `emitColor` is on
    // — otherwise WGSL folds the dead code).
    if (meshFeatures & MSH_HAS_THIN_INSTANCES) {
        const hasColor = (meshFeatures & MSH_HAS_INSTANCE_COLOR) !== 0;
        const tiHelpers = _getStandardGeometryThinInstanceHelpers();
        if (!tiHelpers) {
            throw new Error("standard-geometry: thin instances were not preloaded");
        }
        const tiFrag = tiHelpers._fragment(hasColor);
        if (hasColor) {
            const { _fragmentSlots: _drop, ...rest } = tiFrag;
            frags.push({
                ...rest,
                _fragmentSlots: {
                    BC: wgsl`color = vec4<f32>(color.rgb * input.vInstanceColor.rgb, color.a * input.vInstanceColor.a);`,
                },
            });
        } else {
            frags.push(tiFrag);
        }
    }

    const composed = composeStandardGeometryShader(
        features,
        meshFeatures,
        frags,
        view._geometryAttachments,
        "",
        view._emitColor,
        standardContext?.sceneShader ?? null,
        meshVertexLayout
    );
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

    // Re-detect alpha-blend from the *source* material — the view masked
    // MATERIAL_ALPHA_BLEND out so the composer doesn't emit standard's source-over
    // color blend. The per-mesh vertex-alpha opt-in is folded back into `features`
    // (see buildStandardGeometryRenderable) so a vertex-alpha mesh gets its own
    // blended pipeline + depth-write-off variant.
    const alphaBlend = source.alpha < 1 || (features & HAS_OPACITY_TEXTURE) !== 0 || (features & MATERIAL_ALPHA_BLEND) !== 0;

    // Shared material UBO (one per source material per view). All meshes of
    // this material reuse the same UBO; updates are version-guarded.
    const matData = new F32(24);
    const textureLevel = (features & HAS_DIFFUSE_TEXTURE) !== 0 ? 1.0 : 0.0;
    writeStdMaterialData(matData, source, textureLevel);
    const matUBO = createUniformBuffer(engine, matData);

    // UV transform UBO when the vertex stage emits UV math.
    let upUBO: GPUBuffer | null = null;
    try {
        if ((features & NEEDS_UV) !== 0) {
            const uvData = new F32(4);
            writeStandardUvTransformData(uvData, source, isStandardUvInverted(features, source));
            upUBO = createUniformBuffer(engine, uvData);
        }
    } catch (error) {
        matUBO.destroy();
        throw error;
    }

    const needsVelocity = view._geometryAttachments.includes(GeometryTextureType.LINEAR_VELOCITY);
    const res: StandardGeometryViewResources = {
        _composed: composed,
        _features: features,
        _meshFeatures: meshFeatures,
        _sceneFeatures: sceneFeatures,
        _meshBGL: meshBGL,
        _pipelineLayout: pipelineLayout,
        _vertModule: vertModule,
        _fragModule: fragModule,
        _pipelines: new Map(),
        _extFragments: usedExts,
        _vertexBufferBinders: vertexBufferBinders,
        _needsVelocity: needsVelocity,
        _hasSkeletonVelocity: needsVelocity && (features & HAS_SKELETON) !== 0,
        _alphaBlend: alphaBlend,
        _matUBO: matUBO,
        _matData: matData,
        _lastUboVersion: source._uboVersion,
        _upUBO: upUBO,
        _owners: 0,
    };
    cache.set(variantKey, res);
    return res;
}

function _retainViewResources(view: StandardGeometryMaterialView, variantKey: string, res: StandardGeometryViewResources, resources: MeshRebuildResources): void {
    const cache = view._geometry as Map<string, StandardGeometryViewResources>;
    res._owners++;
    let retained = true;
    resources._lifetimeDisposers.push(() => {
        if (!retained) {
            return;
        }
        retained = false;
        res._owners--;
        _disposeViewResourcesIfUnowned(cache, variantKey, res);
    });
}

function _disposeViewResourcesIfUnowned(cache: Map<string, StandardGeometryViewResources>, variantKey: string, res: StandardGeometryViewResources): void {
    if (res._owners) {
        return;
    }
    res._matUBO.destroy();
    res._upUBO?.destroy();
    if (cache.get(variantKey) === res) {
        cache.delete(variantKey);
    }
}

function _createGeometryMeshBindGroup(
    scene: SceneContext,
    view: StandardGeometryMaterialView,
    res: StandardGeometryViewResources,
    mesh: Mesh,
    meshUBO: GPUBuffer,
    previousBoneTexture: GPUTexture | null,
    disposers: (() => void)[]
): GPUBindGroup {
    const engine = scene.surface.engine;
    const source = view.source as StandardMaterialProps;
    const features = res._features;
    let nextBinding = 0;
    const entries: GPUBindGroupEntry[] = [{ binding: nextBinding++, resource: { buffer: meshUBO } }];
    if ((res._meshFeatures & MSH_HAS_MORPH_TARGETS) !== 0 && mesh.morphTargets) {
        entries.push(
            { binding: nextBinding++, resource: { buffer: mesh.morphTargets.deltasBuffer } },
            { binding: nextBinding++, resource: { buffer: mesh.morphTargets.weightsBuffer } }
        );
    }
    entries.push({ binding: nextBinding++, resource: { buffer: res._matUBO } });
    if ((features & HAS_DIFFUSE_TEXTURE) !== 0 && source.diffuseTexture) {
        const tex = source.diffuseTexture;
        entries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }
    if ((features & NEEDS_UV) !== 0 && res._upUBO) {
        entries.push({ binding: nextBinding++, resource: { buffer: res._upUBO } });
    }
    for (const used of res._extFragments) {
        if (used._ext._bind) {
            nextBinding = used._ext._bind(source, entries, nextBinding, mesh, scene, disposers, true);
        }
    }
    // Geometry-params `gp` UBO is contributed by the geometry composer as the
    // last fragment, so its binding is appended last. Present iff the
    // requested attachments need it (LINEAR_VELOCITY or NORMALIZED_VIEW_DEPTH).
    if (view._gpUBO) {
        entries.push({ binding: nextBinding++, resource: { buffer: view._gpUBO } });
    }
    if (res._hasSkeletonVelocity) {
        if (!previousBoneTexture) {
            throw new Error("standard-geometry: skeletal velocity requires a previous-bone texture");
        }
        entries.push({ binding: nextBinding++, resource: previousBoneTexture.createView() });
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
        // Render upright — "ccw" unless the mesh is mirrored, in which case its triangle winding is
        // reversed exactly as in the forward pass and its depth/normal/velocity output would
        // otherwise be culled away. Resolution goes through the opt-in hook so unmirrored bundles
        // fold the whole thing to the plain "ccw" literal. The variant key already includes
        // meshFeatures, so a winding change gets its own pipeline.
        primitive: { topology: "triangle-list", cullMode, frontFace: _geometryWinding ? _geometryWinding(res._meshFeatures) : "ccw" },
    });
    res._pipelines.set(key, pipeline);
    return pipeline;
}
