import type { SceneContext, SceneContextInternal } from "../../scene/scene.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import { computeSceneSize } from "./scene-size.js";

export interface DdsEnvironmentBackgroundOptions {
    skyboxUrl: string;
    groundTextureUrl: string;
    skyboxSize: number;
    /** Matches Babylon.js BackgroundMaterial.enableNoise. Default true. */
    enableNoise?: boolean;
}

export function addDdsEnvironmentBackground(scene: SceneContext, options: DdsEnvironmentBackgroundOptions): void {
    const sc = scene as SceneContextInternal;
    const engine = scene.engine as EngineContextInternal;
    const groundTexPromise = fetch(options.groundTextureUrl)
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b, { premultiplyAlpha: "none" }));
    const enableNoise = options.enableNoise ?? true;

    sc._deferredBuilders.push(async () => {
        const primaryColor = scene.environmentPrimaryColor ?? [0.08697355964132344, 0.08697355964132344, 0.2122208331110881];
        const { groundSize, skyboxSize, rootPosition } = computeSceneSize(scene, options.skyboxSize);
        const { buildDdsSkyboxRenderable } = await import("./background-dds-skybox.js");
        const { buildGroundRenderable } = await import("./background-ground.js");
        sc._renderables.push(await buildDdsSkyboxRenderable(scene, skyboxSize / 2, rootPosition, primaryColor, options.skyboxUrl, enableNoise));
        sc._renderables.push(await buildGroundRenderable(engine, groundSize, rootPosition, primaryColor, options.groundTextureUrl, groundTexPromise, enableNoise));
    });
}
