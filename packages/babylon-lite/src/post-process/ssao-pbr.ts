import type { SceneContext } from "../scene/scene-core.js";
import type { SsaoTask } from "./ssao.js";
import type { SsaoGpu } from "./ssao-gpu.js";
import type { RenderTarget } from "../engine/render-target.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { getPbrGroupBuilder } from "../material/pbr/pbr-material.js";
import { getMaterialSource } from "../material/material-view.js";
import type { MaterialPlugin } from "../material/plugin/material-plugin.js";
import { enableMaterialPlugins } from "../material/plugin/enable-material-plugins.js";
import { enableDynamicPbrBindings } from "../material/plugin/dynamic-pbr-bindings.js";
import { isPbrIblColorPass, pbrPluginSignatureContains } from "../material/plugin/pbr-plugin-passes.js";
import { installPbrDiffuseOcclusion } from "../material/pbr/pbr-diffuse-occlusion.js";
import { acquireTexture } from "../resource/texture-acquire.js";
import { releaseTexture } from "../resource/texture-release.js";
import { acquireGPUTexture } from "../resource/gpu-texture-acquire.js";
import { releaseGPUTexture } from "../resource/gpu-texture-release.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { getNearestSampler } from "../resource/samplers.js";
import { createSolidTexture2D } from "../texture/solid-texture.js";
import { wgsl } from "../shader/wgsl.js";
import { getEffectiveAspectRatio } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import { registerManagedResourceDisposer } from "../resource/managed-resource-hooks.js";

const PLUGIN_NAME = "ssao-diffuse-ibl";

interface SamplingState {
    texture: Texture2D;
    neutral: Texture2D;
    version: number;
    disposed: boolean;
    plugin: MaterialPlugin;
    materials: Set<PbrMaterialProps>;
    device: GPUDevice;
    width: number;
    height: number;
}

let _states: WeakMap<SsaoTask, { scene: SceneContext; sampling: SamplingState }> | null = null;
interface ScopedSampling {
    plugin: MaterialPlugin;
    scenes: WeakMap<object, SamplingState>;
    count: number;
    active: SamplingState | null;
}
let _materials: WeakMap<PbrMaterialProps, ScopedSampling> | null = null;
let _fallbacks: WeakMap<EngineContext, { device: GPUDevice; texture: Texture2D }> | null = null;

function fallbackFor(engine: EngineContext): Texture2D {
    const fallbacks = (_fallbacks ??= new WeakMap());
    let entry = fallbacks.get(engine);
    if (!entry || entry.device !== engine._device) {
        const texture = createSolidTexture2D(engine, 1, 1, 1, 1);
        texture.sampler = getNearestSampler(engine);
        if (entry) {
            const old = entry.texture;
            entry.device = engine._device;
            entry.texture = texture;
            retireGpuResources(engine, () => releaseTexture(old));
        } else {
            entry = { device: engine._device, texture };
            const owned = entry;
            fallbacks.set(engine, owned);
            registerManagedResourceDisposer(engine, () => releaseTexture(owned.texture));
        }
    }
    return entry.texture;
}

function scopedSampling(scene: SceneContext, sampling: SamplingState): ScopedSampling {
    let engine = scene.surface.engine;
    const scoped: ScopedSampling = { plugin: undefined!, scenes: new WeakMap([[scene, sampling]]), count: 1, active: sampling };
    scoped.plugin = {
        ...sampling.plugin,
        _selectBindingScope(scope) {
            engine = (scope as SceneContext).surface.engine;
            scoped.active = scoped.scenes.get(scope) ?? null;
        },
        _bindingVersion: () => scoped.active?.version ?? 0,
        _validateDraw(context) {
            scoped.active?.plugin._validateDraw?.(context);
        },
        bindTextures(out) {
            if (scoped.active) {
                scoped.active.plugin.bindTextures!(out);
            } else {
                out.push({ texture: fallbackFor(engine) });
            }
        },
        getActiveTextures(out) {
            if (scoped.active) {
                scoped.active.plugin.getActiveTextures!(out);
            } else {
                out.push(fallbackFor(engine));
            }
        },
    };
    return scoped;
}

/**
 * Apply an AO task to selected PBR materials' diffuse environment illumination.
 * Call before registerScene. Existing plugins and baked AO are preserved.
 * Direct lights, emissive, transparent/unlit/refractive materials and non-color passes are unaffected.
 */
export async function enablePbrSsao(scene: SceneContext, task: SsaoTask, materials?: readonly PbrMaterialProps[]): Promise<void> {
    const engine = scene.surface.engine;
    const camera = task.camera;
    if (task.engine !== engine || scene.camera !== camera || (task.scene && task.scene !== scene)) {
        throw new Error("PBR SSAO must use this scene's engine and active camera.");
    }
    if (task.outputTexture._disposed || scene._z) {
        throw new Error("Cannot enable PBR SSAO on a disposed task or scene.");
    }
    const states = (_states ??= new WeakMap());
    const entry = states.get(task);
    if (entry && entry.scene !== scene) {
        throw new Error("A PBR SSAO task cannot be shared between scenes.");
    }
    let state = entry?.sampling;
    const selected =
        materials ??
        scene.meshes.flatMap((mesh) => {
            if (!mesh.material) {
                return [];
            }
            const source = getMaterialSource(mesh.material);
            return source._buildGroup === getPbrGroupBuilder() ? [source as PbrMaterialProps] : [];
        });
    for (const material of selected) {
        if (material._buildGroup !== getPbrGroupBuilder()) {
            throw new Error("enablePbrSsao accepts only PBR source materials.");
        }
        if (!state?.materials.has(material)) {
            if (scene._built) {
                throw new Error("Enable PBR SSAO on new materials before registerScene.");
            }
            const shared = _materials?.get(material);
            if (material.plugins?.some((plugin) => plugin.name === PLUGIN_NAME && plugin !== shared?.plugin) || (shared?.scenes.has(scene) && shared.scenes.get(scene) !== state)) {
                throw new Error("A different SSAO plugin is already attached to this material.");
            }
        }
    }
    enableDynamicPbrBindings();
    installPbrDiffuseOcclusion((index, features, features2) =>
        isPbrIblColorPass(features, features2, true) && pbrPluginSignatureContains(index, PLUGIN_NAME) ? wgsl`min(occlusion,ssaoDiffuseVisibility)` : null
    );

    if (!state) {
        const makeNeutral = (): Texture2D => {
            const neutral = createSolidTexture2D(engine, 1, 1, 1, 1);
            neutral.sampler = getNearestSampler(engine);
            return neutral;
        };
        const neutral = makeNeutral();
        const sampling: SamplingState = {
            texture: neutral,
            neutral,
            version: 0,
            disposed: false,
            plugin: undefined!,
            materials: new Set(),
            device: engine._device,
            width: 0,
            height: 0,
        };
        const replace = (texture: Texture2D): void => {
            if (sampling.texture === texture) {
                return;
            }
            acquireTexture(texture);
            const old = sampling.texture;
            sampling.texture = texture;
            sampling.version++;
            retireGpuResources(engine, () => releaseTexture(old));
        };
        const ensureNeutral = (): void => {
            if (sampling.device === engine._device) {
                return;
            }
            const old = sampling.neutral;
            sampling.neutral = makeNeutral();
            sampling.device = engine._device;
            replace(sampling.neutral);
            retireGpuResources(engine, () => releaseTexture(old));
        };
        // Independent leases for the stable neutral fallback and current sampled generation.
        acquireTexture(neutral);
        sampling.plugin = {
            name: PLUGIN_NAME,
            _pbrIblOnly: true,
            _bindingVersion: () => sampling.version,
            _validateDraw(context) {
                if (context._camera !== camera) {
                    throw new Error("PBR SSAO cannot be sampled by a pass using a different camera.");
                }
                if (
                    sampling.width &&
                    getEffectiveAspectRatio(camera, context.targetWidth, context.targetHeight) !== getEffectiveAspectRatio(camera, sampling.width, sampling.height)
                ) {
                    throw new Error("PBR SSAO and its consuming pass must use the same camera aspect ratio.");
                }
            },
            getCustomCode(type) {
                if (type !== "fragment") {
                    return null;
                }
                return {
                    CUSTOM_FRAGMENT_MAIN_BEGIN: wgsl`let ssaoClip=scene.viewProjection*vec4f(input.worldPos,1);
let ssaoUv=vec2f(ssaoClip.x/ssaoClip.w*0.5+0.5,0.5-ssaoClip.y/ssaoClip.w*0.5);
let ssaoDiffuseVisibility=textureSampleLevel(ssaoVisibilityTexture,ssaoVisibilitySampler,ssaoUv,0).r;`,
                };
            },
            getSamplers: () => [{ texture: "ssaoVisibilityTexture", sampler: "ssaoVisibilitySampler", samplerType: "sampler_non_filtering" }],
            bindTextures(out) {
                if (sampling.disposed) {
                    throw new Error("PBR SSAO sampling state has been disposed.");
                }
                ensureNeutral();
                out.push({ texture: sampling.texture });
            },
            getActiveTextures(out) {
                ensureNeutral();
                out.push(sampling.texture);
            },
        };
        const publish = (gpu: SsaoGpu, target: RenderTarget): void => {
            if (sampling.disposed) {
                return;
            }
            ensureNeutral();
            const output = gpu.outputTexture ?? gpu.visibility;
            sampling.width = gpu.outputTexture?.width ?? gpu.width;
            sampling.height = gpu.outputTexture?.height ?? gpu.height;
            if (!gpu.releaseVisibility) {
                acquireGPUTexture(output);
                gpu.releaseVisibility = () => releaseGPUTexture(output);
            }
            if (sampling.texture.texture === output) {
                return;
            }
            replace({
                texture: output,
                view: target._colorView!,
                sampler: getNearestSampler(engine),
                width: sampling.width,
                height: sampling.height,
                invertY: true,
            });
        };
        const previousOutput = task._onOutputChanged;
        task._onOutputChanged = (gpu, target) => {
            previousOutput?.(gpu, target);
            publish(gpu, target);
        };
        const previousDispose = task._onDispose;
        task._onDispose = () => {
            previousDispose?.();
            if (!sampling.disposed) {
                ensureNeutral();
                sampling.width = sampling.height = 0;
                replace(sampling.neutral);
            }
        };
        if (task._gpu) {
            publish(task._gpu, task.outputTexture);
        }
        scene._disposables.push(() => {
            if (sampling.disposed) {
                return;
            }
            sampling.disposed = true;
            for (const material of sampling.materials) {
                const shared = _materials?.get(material);
                if (shared) {
                    shared.scenes.delete(scene);
                    if (shared.active === sampling) {
                        shared.active = null;
                    }
                    if (--shared.count === 0) {
                        material.plugins = material.plugins?.filter((plugin) => plugin !== shared.plugin);
                        material._renderFeatures = undefined;
                        _materials!.delete(material);
                    }
                }
            }
            retireGpuResources(engine, () => {
                releaseTexture(sampling.texture);
                releaseTexture(sampling.neutral);
            });
            states.delete(task);
        });
        state = sampling;
        states.set(task, { scene, sampling });
    }
    for (const material of selected) {
        if (state.materials.has(material)) {
            continue;
        }
        const materials = (_materials ??= new WeakMap());
        let shared = materials.get(material);
        if (shared) {
            shared.scenes.set(scene, state);
            shared.active = state;
            shared.count++;
        } else {
            shared = scopedSampling(scene, state);
            materials.set(material, shared);
            material.plugins = [...(material.plugins ?? []), shared.plugin];
            material._renderFeatures = undefined;
        }
        state.materials.add(material);
    }
    enableMaterialPlugins(scene);
}
