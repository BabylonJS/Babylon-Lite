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

/** Write the opt-in environment slice of the SceneUniforms struct: rotation
 *  (offset 36) and spherical harmonics (offsets 40–75). */
function writeEnvUbo(data: Float32Array, scene: SceneContext): void {
    data[36] = scene.envRotationY ?? 0;
    const sh = scene._envTextures?.sphericalHarmonics;
    if (sh) {
        data.set(sh, 40);
    }
}

function installEnvironmentRotationInvalidation(scene: SceneContext): void {
    if (scene._environmentRotationInvalidationInstalled) {
        return;
    }
    scene._environmentRotationInvalidationInstalled = true;

    let rotation = scene.envRotationY;
    Object.defineProperty(scene, "envRotationY", {
        configurable: true,
        enumerable: true,
        get: () => rotation,
        set: (value: number | undefined) => {
            if (value !== rotation) {
                rotation = value;
                _invalidateSceneUboCaches(scene);
            }
        },
    });
}

/** @internal Register a contributor on the scene, deduping by function reference. */
export function _registerSceneUboContributor(scene: SceneContext, contributor: SceneUboContributor): void {
    const list = (scene._sceneUboContributors ??= []);
    if (!list.includes(contributor)) {
        list.push(contributor);
    }
}

/** @internal Force every forward render task to rewrite its scene UBO. */
export function _invalidateSceneUboCaches(scene: SceneContext): void {
    for (const task of scene._frameGraph._tasks) {
        if ("_su" in task) {
            (task as unknown as { _su: unknown[] })._su.length = 0;
        }
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
    _registerSceneUboContributor(scene, writeFogUbo);
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
    _registerSceneUboContributor(scene, writeClipPlaneUbo);
}

/**
 * Register the environment rotation and spherical-harmonics scene-uniform contributor.
 * Called by the environment loaders right after assigning `scene._envTextures`.
 * @internal
 */
export function registerEnvSceneUniforms(scene: SceneContext): void {
    installEnvironmentRotationInvalidation(scene);
    _registerSceneUboContributor(scene, writeEnvUbo);
}
