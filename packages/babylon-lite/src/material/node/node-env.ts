/** Node Material — env IBL extension (dynamically imported).
 *
 *  Loaded ONLY when a graph's emitGraph pass set `state.usesEnv = true` (i.e.
 *  a ReflectionBlock fed PBRMetallicRoughnessBlock.reflection). Scenes whose
 *  NME graphs contain neither block never bundle this module — keeping the
 *  per-NME-scene cost flat for non-env materials (scenes 60-66).
 *
 *  Provides the env-aware compile + renderable paths:
 *    1. Group-1 binding allocation + WGSL var decls + BGL entries for the
 *       env IBL textures and samplers (specular cube, BRDF LUT, plus their
 *       samplers).
 *    2. Bind-group entry construction from `scene._envTextures`.
 *
 *  SH coefficients and env scalars are read from the canonical frame-graph
 *  scene UBO; NodeMaterial does not allocate or write a private scene UBO.
 */

import type { SceneContext } from "../../scene/scene.js";

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
