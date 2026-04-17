/** Background renderables — skybox + ground for PBR environment scenes.
 *
 *  Only built when an environment is loaded. Ground and HDR skybox are
 *  dynamically imported so scenes that don't use them pay zero cost.
 *  (skybox = order 0, ground = order 200 for transparency). */

import type { SceneContext } from "../../scene/scene.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { Renderable } from "../../render/renderable.js";
import { computeSceneSize } from "./skybox-geometry.js";

export interface BackgroundRenderableOptions {
    /** When true, skip the solid-color skybox (e.g. caller provides HDR skybox separately). */
    skipSkybox?: boolean;
    /** When true, skip ground plane rendering. */
    skipGround?: boolean;
    /** Skybox size matching BJS createDefaultEnvironment skyboxSize option. */
    skyboxSize?: number;
}

/** Build background renderables (skybox + ground) for a PBR environment scene. */
export async function buildBackgroundRenderables(
    scene: SceneContext,
    envTextures: EnvironmentTextures,
    sceneBindGroupLayout: GPUBindGroupLayout,
    sceneBindGroup: GPUBindGroup,
    groundTextureUrl?: string,
    options?: BackgroundRenderableOptions,
    groundImagePromise?: Promise<ImageBitmap>
): Promise<Renderable[]> {
    const engine = scene.engine as EngineContextInternal;
    const primaryColor = scene.environmentPrimaryColor ?? [0.08697355964132344, 0.08697355964132344, 0.2122208331110881];

    const { groundSize, skyboxSize, rootPosition } = computeSceneSize(scene, options?.skyboxSize);

    const renderables: Renderable[] = [];

    // ─── Skybox ────────────────────────────────────────────────
    if (!options?.skipSkybox) {
        const { buildSolidSkyboxRenderable } = await import("./background-solid-skybox.js");
        renderables.push(buildSolidSkyboxRenderable(scene, envTextures, sceneBindGroupLayout, sceneBindGroup, skyboxSize / 2, rootPosition, primaryColor));
    }

    // ─── Ground ────────────────────────────────────────────────
    if (!options?.skipGround) {
        const { buildGroundRenderable } = await import("./background-ground.js");
        const groundRenderable = await buildGroundRenderable(
            engine,
            sceneBindGroupLayout,
            engine.format,
            engine.msaaSamples,
            sceneBindGroup,
            groundSize,
            rootPosition,
            primaryColor,
            groundTextureUrl,
            groundImagePromise
        );
        renderables.push(groundRenderable);
    }

    return renderables;
}
