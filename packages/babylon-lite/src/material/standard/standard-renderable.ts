/** Standard mesh renderable — builds Renderables from Mesh + StandardMaterial.
 *
 *  `buildStandardMeshRenderables` does shared per-scene setup, then delegates
 *  per-mesh work to `buildSingleStandardRenderable`. The same single-mesh
 *  function is reused by the material-swap path. */

import { F32 } from "../../engine/typed-arrays.js";
import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { Renderable, MeshGroupBuildResult } from "../../render/renderable.js";
import { collectStdBoundTextures } from "./collect-std-bound-textures.js";
import type { StandardMaterialProps, StandardSceneShaderContext } from "./standard-material.js";
import { _computeStandardMaterialFeatures, _standardShaderVariantKey } from "./standard-material.js";
import { acquireTexture, releaseTexture, clearSamplerCache } from "../../resource/gpu-pool.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import {
    getOrCreateStandardBindings,
    getOrCreateStandardPipeline,
    createStandardMeshBindGroup,
    clearStandardPipelineCache,
    writeStdMaterialData,
    _stdVertexColorFragment,
} from "./standard-pipeline.js";
import {
    ESM_SHADOW_OUTPUT,
    NO_COLOR_OUTPUT,
    NEEDS_UV,
    NEEDS_UV2,
    HAS_OPACITY_TEXTURE,
    HAS_DIFFUSE_TEXTURE,
    MATERIAL_ALPHA_BLEND,
    VERTEX_ALPHA,
    _getStdExtsSorted,
} from "./standard-flags.js";
import type { StdExt } from "./standard-flags.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { ShadowGenerator } from "../../shadow/shadow-generator.js";
import { writeMeshLightSelection } from "../../render/lights-ubo.js";
import type { Material, MaterialRenderFeatures } from "../material.js";
import { _computeMeshFeatures, MSH_HAS_INSTANCE_COLOR, MSH_HAS_MORPH_TARGETS, MSH_HAS_THIN_INSTANCES, MSH_RECEIVE_SHADOWS } from "../mesh-features.js";
import { packMat4IntoF32 } from "../../math/pack-mat4-into-f32.js";

/** Scratch buffer for material UBO writes (24 floats = 96 bytes). Reused across
 *  every Standard renderable since binding updates are single-threaded per frame. */
const _stdMatScratch = new F32(24);

/** Thin instance GPU sync callback type — loaded dynamically only when needed. */
type ThinInstanceSync = (
    engine: EngineContext,
    ti: any,
    pass: GPURenderPassEncoder | GPURenderBundleEncoder,
    slot: number,
    hasColor: boolean,
    drawBuffers?: import("../../mesh/thin-instance-gpu.js").ThinInstanceDrawBuffers | null
) => number;

/** Fragment factories passed from the async group builder. */
export interface StdFragmentFactories {
    tiSync?: ThinInstanceSync;
    /** Uploads dirty thin-instance data and promotes cached draws to stable indirect args when their count changes. */
    tiUpdate?: (engine: EngineContext, ti: any, hasColor: boolean, indexCount: number) => GPUBuffer | null;
    tiFragment?: (hasColor: boolean) => ShaderFragment;
    shadowFragment?: (shadowLights: import("./fragments/std-shadow-fragment.js").ShadowLightSlot[]) => ShaderFragment;
    /** Present only when at least one mesh in the build has morph targets. */
    morphFragment?: () => ShaderFragment;
    /** Present only when the scene has at least one culling-enabled thin-instance mesh. */
    cull?: typeof import("../../mesh/thin-instance-cull-binding.js");
    /** Scene-driven Standard WGSL inputs (currently dynamic fog). */
    sceneShader?: StandardSceneShaderContext | null;
}

/** Build Renderable(s) + a SceneUniformUpdater for a set of standard meshes.
 *  The `rebuildSingle` closure is reused later (via `_rebuildSingle` on the group
 *  builder) for material swaps + per-pass material overrides. */
export function buildStandardMeshRenderables(scene: SceneContext, meshes: Mesh[], factories: StdFragmentFactories): MeshGroupBuildResult {
    const engine = scene.surface.engine;
    const { morphFragment, sceneShader = null } = factories;

    // Collect per-light shadow info.
    const shadowLights: { lightIndex: number; shadowType: "esm" | "pcf" | "csm"; gen: ShadowGenerator }[] = [];
    for (let i = 0; i < scene.lights.length; i++) {
        const sg = scene.lights[i]!.shadowGenerator;
        if (sg) {
            shadowLights.push({ lightIndex: i, shadowType: sg._shadowType, gen: sg });
        }
    }
    const hasSomeShadows = shadowLights.length > 0;

    // All receiving meshes in this build share the same shadow generators,
    // so keying the shadow BG by `bindings._shadowBGL` alone is correct.
    const shadowBGCache = new Map<GPUBindGroupLayout, GPUBindGroup>();

    // Per-scene rebuild context. The Standard group builder is a process-wide
    // singleton, so its `_rebuildSingle` must NOT close over a single scene's
    // engine/device/fog(sceneShader)/shadow context — the last scene to build
    // would otherwise poison every other scene's material swaps. Instead the
    // context is stashed on the scene and re-derived per call from the scene
    // passed to `rebuildSingle`, mirroring `_standardGeometryContext`.
    const rebuildContext: StandardRebuildContext = {
        _engine: engine,
        _shadowLights: shadowLights,
        _hasSomeShadows: hasSomeShadows,
        _shadowBGCache: shadowBGCache,
        _factories: factories,
    };
    (scene as SceneContext & { _standardRebuildContext?: StandardRebuildContext })._standardRebuildContext = rebuildContext;

    // Closure used both for the initial per-mesh build below AND for later
    // material-swap / per-pass-override rebuilds (set on standardGroupBuilder._rebuildSingle).
    // It reads its engine/device/fog/shadow context from the *passed* scene so a
    // singleton `_rebuildSingle` never cross-contaminates scenes.
    const rebuildSingle = (s: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable => {
        const rc = (s as SceneContext & { _standardRebuildContext?: StandardRebuildContext })._standardRebuildContext ?? rebuildContext;
        const engine = rc._engine;
        const device = engine._device;
        const shadowLights = rc._shadowLights;
        const hasSomeShadows = rc._hasSomeShadows;
        const shadowBGCache = rc._shadowBGCache;
        const { tiSync, tiUpdate, tiFragment, shadowFragment, cull, morphFragment, sceneShader = null } = rc._factories;
        const mat = (materialOverride ?? mesh.material) as StandardMaterialProps;
        const renderFeatures = (mat._renderFeatures ??= { features: _computeStandardMaterialFeatures(mat) }) as MaterialRenderFeatures;
        const isOverride = materialOverride != null;
        let features = renderFeatures.features;
        const shadowOutput = (features & (NO_COLOR_OUTPUT | ESM_SHADOW_OUTPUT)) !== 0;
        const receiveShadows = !shadowOutput && mesh.receiveShadows && hasSomeShadows;
        const meshFeatures = _computeMeshFeatures(mesh, receiveShadows);
        // Vertex colour via the canonical `enableStandardVertexColors()` seam (master
        // #430): RGB is always applied. Explicit vertex-alpha opt-in (Babylon
        // `mesh.hasVertexAlpha`) layers on top — the mesh must carry a vertex-colour
        // buffer AND opt in. Computed BEFORE the ext loop so the vertex-colour fragment
        // composes with the correct alpha mode. Two effects:
        //   • VERTEX_ALPHA        — the shader consumes `vColor.a` (alpha + alpha-test).
        //   • MATERIAL_ALPHA_BLEND — the pipeline source-over blends, disables depth
        //     write, and sorts the mesh into the transparent phase.
        // RGB vertex colour is always applied regardless. `MATERIAL_ALPHA_BLEND` alone
        // (e.g. a translucent `mat.alpha < 1` material) never enables VERTEX_ALPHA.
        const hasVertexColor = !!mesh._gpu.colorBuffer && !!_stdVertexColorFragment;
        const vertexAlphaBlend = !shadowOutput && hasVertexColor && mesh.hasVertexAlpha === true;
        if (vertexAlphaBlend) {
            features |= VERTEX_ALPHA | MATERIAL_ALPHA_BLEND;
        }
        const sortedExts = _getStdExtsSorted();
        // Build per-feature fragment list (deduped via pipeline cache).
        const frags: ShaderFragment[] = [];
        // Keep morph first: composeStandardShader uses the first fragment's patch
        // to switch the placeholder morph bindings to storage buffers.
        if (meshFeatures & MSH_HAS_MORPH_TARGETS && morphFragment) {
            frags.push(morphFragment());
        }
        const vertexBufferBinders: NonNullable<StdExt["_bindVertexBuffers"]>[] = [];
        for (const ext of sortedExts) {
            features |= ext._meshFeatures?.(meshFeatures) ?? 0;
            if (features & ext._feature) {
                const f = ext._frag(features, meshFeatures);
                if (f) {
                    frags.push(f);
                }
                if (ext._bindVertexBuffers) {
                    vertexBufferBinders.push(ext._bindVertexBuffers);
                }
            }
        }
        // Vertex colour LAST among texture-consuming fragments: its opt-in alpha-test
        // reads the diffuse sample `_ds`, which the diffuse ext defines in its own AT
        // slot, so the vertex-colour AT slot must be appended after the ext loop. Its
        // `color` vertex attribute therefore follows the ext (skeleton) attributes, and
        // the draw closure binds `colorBuffer` after the ext vertex-buffer binders.
        if (hasVertexColor) {
            frags.push(_stdVertexColorFragment!((features & HAS_DIFFUSE_TEXTURE) !== 0, vertexAlphaBlend));
        }
        let shaderKey = "";
        if (meshFeatures & MSH_RECEIVE_SHADOWS && shadowFragment) {
            const slots = shadowLights.map((sl) => ({ lightIndex: sl.lightIndex, shadowType: sl.shadowType }));
            shaderKey = _standardShaderVariantKey(slots);
            frags.push(shadowFragment(slots));
        }
        if (meshFeatures & MSH_HAS_THIN_INSTANCES && tiFragment) {
            const hasColor = !!(meshFeatures & MSH_HAS_INSTANCE_COLOR);
            const tiFrag = tiFragment(hasColor);
            if (hasColor) {
                // Standard applies instance color to final color (BC), not to baseColor (AT) like PBR.
                const { _fragmentSlots: _fragmentSlots, ...rest } = tiFrag;
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
        const esmShadowDepthCode = (features & ESM_SHADOW_OUTPUT) !== 0 ? (mat as StandardMaterialProps & { readonly _esmShadowDepthCode: string })._esmShadowDepthCode : "";
        const bindings = getOrCreateStandardBindings(
            engine,
            features,
            meshFeatures,
            frags,
            shaderKey,
            esmShadowDepthCode,
            (mat as StandardMaterialProps).stencil ?? null,
            shadowOutput ? null : sceneShader
        );

        const meshShadowGens = receiveShadows ? shadowLights.map((sl) => sl.gen) : [];

        const meshUboData = new F32(bindings._composed._meshUboSpec._totalBytes / 4);
        const _packMeshWorld = engine._makePackMeshWorld?.(s as SceneContext) ?? packMat4IntoF32;
        _packMeshWorld(meshUboData, mesh.worldMatrix, 0, 0);
        writeMeshLightSelection(mesh, s.lights, meshUboData);
        const meshUBO = createUniformBuffer(engine, meshUboData);
        const textureLevel = (features & NEEDS_UV) !== 0 ? 1.0 : 0;
        const matData = new F32(24);
        writeStdMaterialData(matData, mat, textureLevel);
        const materialUBO = createUniformBuffer(engine, matData);
        const meshBindGroup = createStandardMeshBindGroup(engine, bindings, meshUBO, materialUBO, mat, mesh.morphTargets ?? null, mesh);

        // Shadow bind group (group 2) — shared across receiving meshes via shadowBGCache.
        let shadowBindGroup: GPUBindGroup | null = null;
        if (meshShadowGens.length > 0 && bindings._shadowBGL) {
            let cached = shadowBGCache.get(bindings._shadowBGL);
            if (!cached) {
                const entries: GPUBindGroupEntry[] = [];
                let b = 0;
                for (const sg of meshShadowGens) {
                    entries.push({ binding: b++, resource: sg._depthTexture.createView() });
                    entries.push({ binding: b++, resource: sg._depthSampler });
                    entries.push({ binding: b++, resource: { buffer: sg._shadowUBO } });
                }
                cached = device.createBindGroup({ layout: bindings._shadowBGL, entries });
                shadowBGCache.set(bindings._shadowBGL, cached);
            }
            shadowBindGroup = cached;
        }

        const needsUV = (features & NEEDS_UV) !== 0;
        const needsUV2 = (features & NEEDS_UV2) !== 0;
        const hasThinInstances = (meshFeatures & MSH_HAS_THIN_INSTANCES) !== 0;
        const hasInstanceColor = (meshFeatures & MSH_HAS_INSTANCE_COLOR) !== 0;
        const isTransparent = !shadowOutput && ((features & HAS_OPACITY_TEXTURE) !== 0 || mat.alpha < 1 || vertexAlphaBlend);

        const boundTextures = collectStdBoundTextures(mat);
        for (const t of boundTextures) {
            acquireTexture(t);
        }
        s._meshDisposables.set(mesh, [
            () => {
                for (const t of boundTextures) {
                    releaseTexture(t);
                }
            },
        ]);

        let _lastWorldVersion = mesh.worldMatrixVersion;
        let _lastLightsCount = s.lights.length;
        let thinDrawArgs: GPUBuffer | null = null;
        const sortCenter = [mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!] as [number, number, number];
        const _baseUpdate = (): void => {
            const worldVersion = mesh.worldMatrixVersion;
            if (worldVersion !== _lastWorldVersion || s.lights.length !== _lastLightsCount) {
                sortCenter[0] = mesh.worldMatrix[12]!;
                sortCenter[1] = mesh.worldMatrix[13]!;
                sortCenter[2] = mesh.worldMatrix[14]!;
                _packMeshWorld(meshUboData, mesh.worldMatrix, 0, 0);
                writeMeshLightSelection(mesh, s.lights, meshUboData);
                device.queue.writeBuffer(meshUBO, 0, meshUboData as Float32Array<ArrayBuffer>);
                _lastWorldVersion = worldVersion;
                _lastLightsCount = s.lights.length;
            }
            const uboVersion = mat._uboVersion;
            if (uboVersion !== _lastUboVersion) {
                _lastUboVersion = uboVersion;
                _stdMatScratch.fill(0);
                writeStdMaterialData(_stdMatScratch, mat, textureLevel);
                device.queue.writeBuffer(materialUBO, 0, _stdMatScratch.buffer, 0, 96);
            }
            const ti = hasThinInstances ? mesh.thinInstances : null;
            if (ti && tiUpdate) {
                thinDrawArgs = tiUpdate(engine, ti, hasInstanceColor, mesh._gpu.indexCount);
            }
        };
        // FO-version wrapper applied only when the engine has floating-origin
        // on. The wrapper lives in the dynamic-imported `floating-origin.ts`
        // module and is the sole owner of `_lastFoVersion` tracking. For
        // non-LWR engines `_wrapRenderableForFO` is undefined and `update`
        // is the bare closure — no FO bytes in the closure body.
        const _invalidate = (): void => {
            _lastWorldVersion = -1;
        };
        const update = engine._wrapRenderableForFO?.(_baseUpdate, s as SceneContext, _invalidate) ?? _baseUpdate;

        const draw = (pass: GPURenderPassEncoder | GPURenderBundleEncoder, cullBinding?: import("../../mesh/thin-instance-cull-binding.js").TiCullBinding): number => {
            // For per-pass material overrides, skip the mesh.material === mat guard
            // because the override material is intentionally not the mesh's current one.
            if (!isOverride && mesh.material !== mat) {
                return 0;
            }
            const g = mesh._gpu;
            let slot = 0;
            const vb = g._vbLayout;
            pass.setVertexBuffer(slot++, g.positionBuffer, vb?._p?._offset);
            pass.setVertexBuffer(slot++, g.normalBuffer, vb?._n?._offset);
            if (needsUV) {
                pass.setVertexBuffer(slot++, g.uvBuffer, vb?._u?._offset);
            }
            if (needsUV2 && g.uv2Buffer) {
                pass.setVertexBuffer(slot++, g.uv2Buffer, vb?._u2?._offset);
            }
            for (const bindVertexBuffers of vertexBufferBinders) {
                slot = bindVertexBuffers(mesh, pass, slot);
            }
            if (hasVertexColor) {
                pass.setVertexBuffer(slot++, g.colorBuffer!, vb?._c?._offset);
            }

            const ti = hasThinInstances ? mesh.thinInstances : null;
            if (ti && tiSync) {
                slot = tiSync(engine, ti, pass, slot, hasInstanceColor, cullBinding?.cullDrawBufs);
            }

            pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
            pass.setBindGroup(1, meshBindGroup);
            if (receiveShadows && shadowBindGroup) {
                pass.setBindGroup(2, shadowBindGroup);
            }
            if (cullBinding) {
                cullBinding.draw(pass, g.indexCount, ti!.count);
            } else if (ti && thinDrawArgs) {
                pass.drawIndexedIndirect(thinDrawArgs, 0);
            } else {
                pass.drawIndexed(g.indexCount, ti?.count);
            }
            return 1;
        };

        const r: Renderable = {
            order: mesh.renderOrder ?? (isTransparent ? 200 : 100),
            isTransparent,
            mesh,
            bind(eng, sig) {
                const pipeline = getOrCreateStandardPipeline(eng as EngineContext, sig, bindings);
                // Opaque-only GPU culling (opt-in): tryBind gates on opt-in + transparency, returns the per-binding cull lifecycle.
                const cb = cull?.tryBind(r, s, mesh, engine, hasInstanceColor, isTransparent, update, sig);
                return {
                    renderable: r,
                    pipeline,
                    ...(cb ? { _updateBatches: [cb._updateBatch] } : {}),
                    update: cb ? cb.update : update,
                    draw: (pass) => draw(pass, cb),
                };
            },
        };
        r._worldCenter = sortCenter;
        let _lastUboVersion = mat._uboVersion;
        return r;
    };

    const renderables = meshes.map((m) => rebuildSingle(scene, m));

    (scene as SceneContext & { _standardGeometryContext?: StandardGeometryContext })._standardGeometryContext = {
        _sceneShader: sceneShader,
        _morphFragment: morphFragment,
    };

    scene._disposables.push(
        () => clearStandardPipelineCache(),
        () => clearSamplerCache(engine)
    );

    return { renderables, rebuildSingle };
}

/** @internal Per-scene Standard state reused by the geometry renderer. */
export interface StandardGeometryContext {
    /** @internal */
    readonly _sceneShader: StandardSceneShaderContext | null;
    /** @internal */
    readonly _morphFragment?: () => ShaderFragment;
}

/** @internal Per-scene context consumed by the singleton Standard group builder's
 *  `_rebuildSingle`. Stashed on the scene (`scene._standardRebuildContext`) so a
 *  material-swap / per-pass-override rebuild derives its engine, device, fog
 *  (`sceneShader`), shadow generators, and dynamically-imported fragment factories
 *  from the scene being rebuilt — never from whichever scene last happened to build
 *  through the shared singleton builder. */
export interface StandardRebuildContext {
    /** @internal */
    readonly _engine: EngineContext;
    /** @internal */
    readonly _shadowLights: { lightIndex: number; shadowType: "esm" | "pcf" | "csm"; gen: ShadowGenerator }[];
    /** @internal */
    readonly _hasSomeShadows: boolean;
    /** @internal */
    readonly _shadowBGCache: Map<GPUBindGroupLayout, GPUBindGroup>;
    /** @internal */
    readonly _factories: StdFragmentFactories;
}
