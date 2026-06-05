import type { SceneContext, ClipPlane } from "./scene-core.js";
import type { FogConfig } from "../material/standard/standard-material.js";

/** A scene-UBO contributor: writes a feature-specific slice of the SceneUniforms
 *  struct. Registered on `scene._sceneUboContributors` and invoked by the render
 *  task after the always-present base writes. */
type SceneUboContributor = (data: Float32Array, scene: SceneContext) => void;

/** Write the fog slice of the SceneUniforms struct (float offsets 80–86). */
function writeFogUbo(data: Float32Array, scene: SceneContext): void {
    const fog = scene.fog;
    if (fog) {
        data[80] = fog.mode;
        data[81] = fog.start;
        data[82] = fog.end;
        data[83] = fog.density;
        data[84] = fog.color[0]!;
        data[85] = fog.color[1]!;
        data[86] = fog.color[2]!;
    }
}

/** Write the clip-plane slice of the SceneUniforms struct (float offsets 88–91). */
function writeClipPlaneUbo(data: Float32Array, scene: SceneContext): void {
    const clipPlane = scene.clipPlane;
    if (clipPlane) {
        data[88] = clipPlane[0];
        data[89] = clipPlane[1];
        data[90] = clipPlane[2];
        data[91] = clipPlane[3];
    }
}

/** Write the environment spherical-harmonics slice of the SceneUniforms struct
 *  (float offsets 40–75). */
function writeEnvShUbo(data: Float32Array, scene: SceneContext): void {
    const sh = scene._envTextures?.sphericalHarmonics;
    if (sh) {
        data.set(sh, 40);
    }
}

/** Register a contributor on the scene, deduping by function reference. */
function registerContributor(scene: SceneContext, contributor: SceneUboContributor): void {
    const list = (scene._sceneUboContributors ??= []);
    if (!list.includes(contributor)) {
        list.push(contributor);
    }
}

/**
 * Enable scene fog and register its scene-uniform contributor.
 *
 * Fog is an opt-in feature: importing `setFog` is what pulls the fog UBO writer
 * into the bundle, keeping those bytes out of scenes that never use fog.
 *
 * @param scene - The scene to configure.
 * @param config - The fog configuration (mode, density, start, end, color).
 */
export function setFog(scene: SceneContext, config: FogConfig): void {
    scene.fog = config;
    registerContributor(scene, writeFogUbo);
}

/**
 * Set the scene clip plane and register its scene-uniform contributor.
 *
 * The clip plane is opt-in: importing `setClipPlane` is what pulls the clip-plane
 * UBO writer into the bundle, keeping those bytes out of scenes that never clip.
 *
 * @param scene - The scene to configure.
 * @param plane - The clip plane as `[a, b, c, d]` coefficients of `a·x + b·y + c·z + d`.
 */
export function setClipPlane(scene: SceneContext, plane: ClipPlane): void {
    scene.clipPlane = plane;
    registerContributor(scene, writeClipPlaneUbo);
}

/**
 * Register the environment spherical-harmonics scene-uniform contributor.
 * Called by the environment loaders right after assigning `scene._envTextures`.
 * @internal
 */
export function registerEnvSceneUniforms(scene: SceneContext): void {
    registerContributor(scene, writeEnvShUbo);
}
