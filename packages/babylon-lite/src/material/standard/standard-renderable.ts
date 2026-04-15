/** Standard mesh renderable — builds Renderables from Mesh + StandardMaterial.
 *
 *  Uses the dynamic pipeline system: each mesh's material features produce a
 *  pipeline key, and meshes are grouped by key to minimise state changes. */

import type { EngineContext } from "../../engine/engine.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext, SceneContextInternal } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshInternal } from "../../mesh/mesh.js";
import type { Renderable, SceneUniformUpdater } from "../../render/renderable.js";
import type { LightBase } from "../../light/types.js";
import { updateSceneUniforms, collectStdBoundTextures } from "./standard-material.js";
import type { StandardMaterialProps } from "./standard-material.js";
import type { PbrMaterialProps } from "../pbr/pbr-material.js";
import { getViewProjectionMatrix, getViewMatrix, getCameraPosition } from "../../camera/camera.js";
import { acquireTexture, releaseTexture, clearSamplerCache } from "../../resource/gpu-pool.js";
import {
    computeFeatures,
    getOrCreatePipeline,
    createDynamicMeshGPU,
    writeLightsUBO,
    refreshLightsUBO,
    releaseStandardPipelineVariant,
    clearStandardPipelineCache,
    LIGHTS_UBO_SIZE,
    NEEDS_UV,
    NEEDS_UV2,
    RECEIVE_SHADOWS,
    HAS_OPACITY_TEXTURE,
    THIN_INSTANCES,
    THIN_INSTANCE_COLOR,
    HAS_BUMP_TEXTURE,
    HAS_EMISSIVE_TEXTURE,
    HAS_SPECULAR_TEXTURE,
    HAS_AMBIENT_TEXTURE,
    HAS_LIGHTMAP_TEXTURE,
    HAS_REFLECTION_TEXTURE,
    HAS_CUBE_REFLECTION,
    LIGHTMAP_USES_UV2,
    AMBIENT_USES_UV2,
    SPECULAR_USES_UV2,
    OPACITY_FROM_RGB,
    writeStdMaterialData,
} from "./standard-pipeline.js";
import { computeLightsVersion } from "../../render/lights-ubo.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { PipelineVariant, DynamicMeshGPU } from "./standard-pipeline.js";
import type { ShadowGenerator } from "../../shadow/shadow-generator.js";

// Scratch buffer for material UBO dirty comparison (24 floats = 96 bytes)
const _stdMatScratch = new Float32Array(24);

interface MeshPacket {
    mesh: Mesh;
    gpu: DynamicMeshGPU;
    _lastMaterial: StandardMaterialProps | PbrMaterialProps;
    _lastWorldVersion: number;
}

interface PipelineGroup {
    variant: PipelineVariant;
    packets: MeshPacket[];
}

/** Thin instance GPU sync callback type — loaded dynamically only when needed. */
type ThinInstanceSync = (engine: EngineContextInternal, ti: any, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number, hasColor: boolean) => number;

/** Fragment factories passed from the async group builder. */
export interface StdFragmentFactories {
    tiSync?: ThinInstanceSync;
    tiFragment?: (hasColor: boolean) => ShaderFragment;
    bumpFragment?: () => ShaderFragment;
    shadowFragment?: (shadowLights: import("./fragments/std-shadow-fragment.js").ShadowLightSlot[]) => ShaderFragment;
    emissiveFragment?: () => ShaderFragment;
    specularFragment?: (usesUV2: boolean) => ShaderFragment;
    ambientFragment?: (usesUV2: boolean) => ShaderFragment;
    lightmapFragment?: (usesUV2: boolean) => ShaderFragment;
    opacityFragment?: (fromRGB: boolean) => ShaderFragment;
    reflectionFragment?: () => ShaderFragment;
    cubeReflectionFragment?: () => ShaderFragment;
}

/** Build Renderable(s) + a SceneUniformUpdater for a set of standard meshes.
 *  Groups meshes by feature bitmask to minimise pipeline state changes. */
export function buildStandardMeshRenderables(scene: SceneContext, meshes: Mesh[], factories: StdFragmentFactories): { renderables: Renderable[]; updater: SceneUniformUpdater } {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;

    // Collect per-light shadow info
    const shadowLights: { lightIndex: number; shadowType: "esm" | "pcf"; gen: ShadowGenerator }[] = [];
    for (let i = 0; i < scene.lights.length; i++) {
        const sg = scene.lights[i]!.shadowGenerator;
        if (sg) {
            shadowLights.push({ lightIndex: i, shadowType: sg.shadowType, gen: sg });
        }
    }
    const hasSomeShadows = shadowLights.length > 0;

    // Per-mesh light filtering: bitmask cache (MAX_LIGHTS=4 → at most 16 entries).
    // When no light has filtering, all meshes hit the same bitmask → one shared UBO.
    const lightsUBOs: GPUBuffer[] = [];
    const lightsForMask: LightBase[][] = []; // parallel to lightsUBOs — lights per bitmask
    const allLights = scene.lights;

    function getLightsBuffer(id: string | undefined): GPUBuffer {
        let m = 0;
        for (let i = 0; i < allLights.length; i++) {
            const l = allLights[i]!,
                inc = l.includedOnlyMeshIds;
            if (!id || (inc?.size ? inc.has(id) : !l.excludedMeshIds?.has(id))) {
                m |= 1 << i;
            }
        }
        if (!lightsUBOs[m]) {
            const filtered = allLights.filter((_, i) => (m >> i) & 1);
            lightsForMask[m] = filtered;
            lightsUBOs[m] = writeLightsUBO(engine, filtered);
        }
        return lightsUBOs[m]!;
    }

    const {
        tiSync,
        tiFragment: tiFragmentFactory,
        bumpFragment: bumpFragmentFactory,
        shadowFragment: shadowFragmentFactory,
        emissiveFragment: emissiveFragmentFactory,
        specularFragment: specularFragmentFactory,
        ambientFragment: ambientFragmentFactory,
        lightmapFragment: lightmapFragmentFactory,
        opacityFragment: opacityFragmentFactory,
        reflectionFragment: reflectionFragmentFactory,
        cubeReflectionFragment: cubeReflectionFragmentFactory,
    } = factories;

    // Group meshes by feature bitmask
    const groups = new Map<number, PipelineGroup>();

    for (const mesh of meshes) {
        const mat = mesh.material as StandardMaterialProps;
        let features = computeFeatures(mat, mesh.receiveShadows);
        if (mesh.thinInstances) {
            features |= THIN_INSTANCES;
        }
        if (mesh.thinInstances?.colors) {
            features |= THIN_INSTANCE_COLOR;
        }
        let group = groups.get(features);
        if (!group) {
            // Build fragments for this feature set
            const frags: ShaderFragment[] = [];
            if (features & HAS_BUMP_TEXTURE && bumpFragmentFactory) {
                frags.push(bumpFragmentFactory());
            }
            if (features & RECEIVE_SHADOWS && shadowFragmentFactory && hasSomeShadows) {
                const slots = shadowLights.map((sl) => ({ lightIndex: sl.lightIndex, shadowType: sl.shadowType }));
                frags.push(shadowFragmentFactory(slots));
            }
            if (features & HAS_EMISSIVE_TEXTURE && emissiveFragmentFactory) {
                frags.push(emissiveFragmentFactory());
            }
            if (features & HAS_SPECULAR_TEXTURE && specularFragmentFactory) {
                frags.push(specularFragmentFactory(!!(features & SPECULAR_USES_UV2)));
            }
            if (features & HAS_AMBIENT_TEXTURE && ambientFragmentFactory) {
                frags.push(ambientFragmentFactory(!!(features & AMBIENT_USES_UV2)));
            }
            if (features & HAS_LIGHTMAP_TEXTURE && lightmapFragmentFactory) {
                frags.push(lightmapFragmentFactory(!!(features & LIGHTMAP_USES_UV2)));
            }
            if (features & HAS_OPACITY_TEXTURE && opacityFragmentFactory) {
                frags.push(opacityFragmentFactory(!!(features & OPACITY_FROM_RGB)));
            }
            if (features & HAS_REFLECTION_TEXTURE && reflectionFragmentFactory) {
                frags.push(reflectionFragmentFactory());
            }
            if (features & HAS_CUBE_REFLECTION && cubeReflectionFragmentFactory) {
                frags.push(cubeReflectionFragmentFactory());
            }
            if (features & THIN_INSTANCES && tiFragmentFactory) {
                const hasColor = !!(features & THIN_INSTANCE_COLOR);
                const tiFrag = tiFragmentFactory(hasColor);
                if (hasColor) {
                    // Standard applies instance color to final color (BC),
                    // not to baseColor (AT) like PBR. Strip the fragment slot
                    // and let the template handle it.
                    const { fragmentSlots: _fragmentSlots, ...rest } = tiFrag;
                    frags.push({
                        ...rest,
                        fragmentSlots: {
                            BC: `color = vec4<f32>(color.rgb * input.vInstanceColor.rgb, color.a * input.vInstanceColor.a);`,
                        },
                    });
                } else {
                    frags.push(tiFrag);
                }
            }
            const variant = getOrCreatePipeline(engine, engine.format, engine.msaaSamples, features, frags);
            group = { variant, packets: [] };
            groups.set(features, group);
        }

        const worldMatrix = mesh.worldMatrix;
        const meshShadowGens = mesh.receiveShadows ? shadowLights.map((sl) => sl.gen) : [];
        const lightsBuffer = getLightsBuffer(mesh.id);
        const gpu = createDynamicMeshGPU(engine, group.variant, {
            worldMatrix,
            material: mat,
            lightsBuffer,
            shadowGenerators: meshShadowGens,
        });
        group.packets.push({ mesh, gpu, _lastMaterial: mat, _lastWorldVersion: mesh.worldMatrixVersion });

        const boundTextures = collectStdBoundTextures(mat);
        for (const t of boundTextures) {
            acquireTexture(t);
        }
        const variant = group.variant;
        (scene as SceneContextInternal)._meshDisposables.set(mesh, [
            () => {
                for (const t of boundTextures) {
                    releaseTexture(t);
                }
            },
            () => releaseStandardPipelineVariant(variant),
        ]);
    }

    // Create one Renderable per pipeline group
    const renderables: Renderable[] = [];
    // All standard variants share the same _sharedSceneUBO — track it once to avoid duplicate writes
    let sharedSceneUBO: GPUBuffer | null = null;

    for (const [, group] of groups) {
        const { variant, packets } = group;
        const needsUV = (variant.features & NEEDS_UV) !== 0;
        const needsUV2 = (variant.features & NEEDS_UV2) !== 0;
        const hasShadow = (variant.features & RECEIVE_SHADOWS) !== 0;

        if (!sharedSceneUBO) {
            sharedSceneUBO = variant.sceneUBO;
        }

        const isTransparent = (variant.features & HAS_OPACITY_TEXTURE) !== 0 || (packets.length > 0 && (packets[0]!.mesh.material as StandardMaterialProps).alpha < 1);
        const hasThinInstances = (variant.features & THIN_INSTANCES) !== 0;
        const hasInstanceColor = (variant.features & THIN_INSTANCE_COLOR) !== 0;

        renderables.push({
            order: isTransparent ? 200 : 100,
            isTransparent,
            _pipeline: variant.pipeline,
            _sceneBG: variant.sceneBG,
            updateUBOs() {
                for (const pkt of packets) {
                    if (pkt.mesh.worldMatrixVersion !== pkt._lastWorldVersion) {
                        device.queue.writeBuffer(pkt.gpu.meshUBO, 0, pkt.mesh.worldMatrix as unknown as Float32Array<ArrayBuffer>);
                        pkt._lastWorldVersion = pkt.mesh.worldMatrixVersion;
                    }
                    const mat = pkt.mesh.material as any;
                    if (mat._uboDirty) {
                        mat._uboDirty = false;
                        _stdMatScratch.fill(0);
                        writeStdMaterialData(_stdMatScratch, mat, pkt.gpu.textureLevel);
                        device.queue.writeBuffer(pkt.gpu.materialUBO, 0, _stdMatScratch.buffer, 0, 96);
                    }
                }
            },
            draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder) {
                pass.setPipeline(variant.pipeline);
                pass.setBindGroup(0, variant.sceneBG);
                let draws = 0;
                for (const pkt of packets) {
                    if (pkt.mesh.material !== pkt._lastMaterial) {
                        continue;
                    }
                    const g = (pkt.mesh as MeshInternal)._gpu;
                    let slot = 0;
                    pass.setVertexBuffer(slot++, g.positionBuffer);
                    pass.setVertexBuffer(slot++, g.normalBuffer);
                    if (needsUV) {
                        pass.setVertexBuffer(slot++, g.uvBuffer);
                    }
                    if (needsUV2 && g.uv2Buffer) {
                        pass.setVertexBuffer(slot++, g.uv2Buffer);
                    }

                    const ti = hasThinInstances ? pkt.mesh.thinInstances : null;
                    if (ti && tiSync) {
                        slot = tiSync(engine, ti, pass, slot, hasInstanceColor);
                    }

                    pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
                    pass.setBindGroup(1, pkt.gpu.meshBG);
                    if (hasShadow && pkt.gpu.shadowBG) {
                        pass.setBindGroup(2, pkt.gpu.shadowBG);
                    }
                    if (ti && ti.count > 0) {
                        pass.drawIndexed(g.indexCount, ti.count);
                    } else {
                        pass.drawIndexed(g.indexCount);
                    }
                    draws++;
                }
                return draws;
            },
        });
    }

    // Pre-allocated scratch buffer for light UBO refresh
    const lightsScratch = new Float32Array(LIGHTS_UBO_SIZE / 4);
    // Per-mask light version tracking — skip refresh when lights haven't changed
    const lightsVersions: number[] = [];
    // Scene UBO dirty tracking
    let _lastCamVersion = -1;
    let _lastAspect = -1;
    let _lastFog: typeof scene.fog = null;

    // Scene uniform updater — writes shared scene UBO once + refreshes light UBOs
    const updater: SceneUniformUpdater = {
        update(engine: EngineContext) {
            if (!scene.camera || !sharedSceneUBO) {
                return;
            }
            const aspect = engine.canvas.width / engine.canvas.height;
            const camVer = scene.camera.worldMatrixVersion;
            // Only rewrite scene UBO if camera or fog changed
            if (camVer !== _lastCamVersion || aspect !== _lastAspect || scene.fog !== _lastFog) {
                _lastCamVersion = camVer;
                _lastAspect = aspect;
                _lastFog = scene.fog;
                const viewProj = getViewProjectionMatrix(scene.camera, aspect);
                const viewMat = getViewMatrix(scene.camera);
                const camPos = getCameraPosition(scene.camera);
                updateSceneUniforms(
                    engine as EngineContextInternal,
                    sharedSceneUBO,
                    viewProj as Float32Array,
                    viewMat as Float32Array,
                    [camPos.x, camPos.y, camPos.z],
                    scene.fog ?? undefined
                );
            }
            // Refresh light UBOs only when light state has changed
            for (let m = 0; m < lightsUBOs.length; m++) {
                const buf = lightsUBOs[m];
                if (buf && lightsForMask[m]) {
                    const ver = computeLightsVersion(lightsForMask[m]!);
                    if (ver !== lightsVersions[m]) {
                        lightsVersions[m] = ver;
                        refreshLightsUBO(engine as EngineContextInternal, buf, lightsForMask[m]!, lightsScratch);
                    }
                }
            }
        },
    };

    // Stash first sceneUBO on scene so other deferred builders (e.g., skybox) can share it
    (scene as SceneContextInternal)._standardSceneUBO = sharedSceneUBO!;

    (scene as SceneContextInternal)._disposables.push(
        () => clearStandardPipelineCache(),
        () => clearSamplerCache(engine)
    );

    return { renderables, updater };
}
