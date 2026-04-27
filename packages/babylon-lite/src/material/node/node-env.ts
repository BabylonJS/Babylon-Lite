/** Node Material — env IBL extension (dynamically imported).
 *
 *  Loaded ONLY when a graph's emitGraph pass set `state.usesEnv = true` (i.e.
 *  a ReflectionBlock fed PBRMetallicRoughnessBlock.reflection). Scenes whose
 *  NME graphs contain neither block never bundle this module — keeping the
 *  per-NME-scene cost flat for non-env materials (scenes 60-66).
 *
 *  Provides four things the env-aware compile + renderable paths need:
 *    1. WGSL fragment for extending the NME scene UBO struct with SH + env
 *       scalars (the base struct is owned by node-pipeline.ts).
 *    2. Group-1 binding allocation + WGSL var decls + BGL entries for the
 *       env IBL textures and samplers (specular cube, BRDF LUT, plus their
 *       samplers).
 *    3. Bind-group entry construction from `scene._envTextures`.
 *    4. Per-frame writer for the SH + env scalar tail of the scene UBO
 *       (offset 176 bytes; 40 floats = 160 bytes).
 */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";

/** Extra bytes appended to the NME scene UBO when env IBL is in use:
 *  9 vec4 SH coefficients (.xyz = SH RGB, .w pad) + vec4(envRotationY,
 *  lodGenerationScale, environmentIntensity, _pad). 144 + 16 = 160 bytes. */
export const NME_SCENE_UBO_ENV_EXTRA_BYTES = 160;

/** WGSL fragment appended to the SceneU struct when env is in use. */
export const SCENE_STRUCT_ENV_FIELDS = `vSphericalL00: vec4<f32>,
    vSphericalL1_1: vec4<f32>,
    vSphericalL10: vec4<f32>,
    vSphericalL11: vec4<f32>,
    vSphericalL2_2: vec4<f32>,
    vSphericalL2_1: vec4<f32>,
    vSphericalL20: vec4<f32>,
    vSphericalL21: vec4<f32>,
    vSphericalL22: vec4<f32>,
    envRotationY: f32,
    lodGenerationScale: f32,
    environmentIntensity: f32,
    _envPad: f32,`;

export interface EnvEmit {
    readonly bindings: {
        readonly iblTexture: number;
        readonly iblSampler: number;
        readonly brdfLUT: number;
        readonly brdfSampler: number;
    };
    readonly wgslDecls: string;
    readonly bglEntries: readonly GPUBindGroupLayoutEntry[];
    readonly bindingCount: number;
}

/** Allocate the 4 group-1 bindings for env IBL (cube + sampler, BRDF LUT 2D + sampler)
 *  starting at `startBinding`, and produce the WGSL `@group(1) @binding(...)` var decls
 *  plus the matching BGL entries. */
export function emitEnv(startBinding: number): EnvEmit {
    const iblTexBinding = startBinding;
    const iblSampBinding = startBinding + 1;
    const brdfTexBinding = startBinding + 2;
    const brdfSampBinding = startBinding + 3;
    const wgslDecls = [
        `@group(1) @binding(${iblTexBinding}) var nmeIblTexture: texture_cube<f32>;`,
        `@group(1) @binding(${iblSampBinding}) var nmeIblSampler: sampler;`,
        `@group(1) @binding(${brdfTexBinding}) var nmeBrdfLUT: texture_2d<f32>;`,
        `@group(1) @binding(${brdfSampBinding}) var nmeBrdfSampler: sampler;`,
    ].join("\n");
    const bglEntries: GPUBindGroupLayoutEntry[] = [
        { binding: iblTexBinding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
        { binding: iblSampBinding, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: brdfTexBinding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: brdfSampBinding, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ];
    return {
        bindings: { iblTexture: iblTexBinding, iblSampler: iblSampBinding, brdfLUT: brdfTexBinding, brdfSampler: brdfSampBinding },
        wgslDecls,
        bglEntries,
        bindingCount: 4,
    };
}

/** Append env IBL texture/sampler entries to a bind-group entries array. */
export function pushEnvBindGroupEntries(
    scene: SceneContext,
    envBindings: { iblTexture: number; iblSampler: number; brdfLUT: number; brdfSampler: number },
    entries: GPUBindGroupEntry[]
): void {
    const env = (scene as unknown as { _envTextures?: import("../../loader-env/load-env.js").EnvironmentTextures })._envTextures;
    if (!env) {
        throw new Error("NodeMaterial: PBR/Reflection block requires scene environment but scene._envTextures is unset. Call loadEnvironment() before registerScene().");
    }
    entries.push({ binding: envBindings.iblTexture, resource: env.specularCubeView });
    entries.push({ binding: envBindings.iblSampler, resource: env.cubeSampler });
    entries.push({ binding: envBindings.brdfLUT, resource: env.brdfLutView });
    entries.push({ binding: envBindings.brdfSampler, resource: env.brdfSampler });
}

/** Write the env tail of the NME scene UBO (offset 176, 40 floats):
 *  9 vec4 SH coefficients + vec4(envRotationY, lodGenerationScale,
 *  environmentIntensity, _pad). */
let _envScratch: Float32Array | null = null;
export function writeEnvSceneTail(engine: EngineContextInternal, sceneUBO: GPUBuffer, scene: SceneContext): void {
    const env = (scene as unknown as { _envTextures?: import("../../loader-env/load-env.js").EnvironmentTextures })._envTextures;
    if (!env) {
        return;
    }
    if (!_envScratch) {
        _envScratch = new Float32Array(40);
    }
    _envScratch.set(env.sphericalHarmonics, 0);
    const envRot = (scene as unknown as { envRotationY?: number }).envRotationY ?? 0;
    _envScratch[36] = envRot;
    _envScratch[37] = env.lodGenerationScale;
    _envScratch[38] = 1.0;
    _envScratch[39] = 0;
    engine.device.queue.writeBuffer(sceneUBO, 176, _envScratch as Float32Array<ArrayBuffer>);
}
