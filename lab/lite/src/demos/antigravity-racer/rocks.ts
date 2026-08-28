/**
 * Antigravity Racer — the decorative boulders.
 *
 * The same CC BY 4.0 "Obj_Nat_Rock_01" model the source playground scatters, at
 * the seven exact transforms authored there (see `ROCK_TRANSFORMS`), drawn as
 * one thin-instance pool.
 *
 * The playground places each boulder by REPLACING the glTF root's own transform
 * (`meshes[0].rotationQuaternion = null; meshes[0].scaling = rocksScale[i]`),
 * which drops Babylon's right-to-left-handed root conversion. Lite's pool
 * composes on top of that conversion instead, so the instance matrix is just
 * the playground's `scale · rotation · translation` above the model hierarchy
 * — no extra mirror. The rock template's static (non-instanced) pipeline was
 * built expecting exactly one flip (the glTF root's), i.e. a negative-
 * determinant world matrix with `frontFace` unchanged; an extra per-instance
 * X mirror used to cancel that flip back to a positive determinant, which
 * left the double-sided PBR material's front/back normal resolution wrong
 * (the rock rendered with inverted lighting). Leaving the root flip alone
 * keeps the determinant negative as the pipeline expects; the resulting
 * mirror of this roughly-symmetric natural rock is not visually significant.
 */

import type { HierarchyInstancePool, SceneContext, SceneNode } from "babylon-lite";
import { addHierarchyInstance, addToScene, mat4Compose } from "babylon-lite";

import { instantiateModel, type RacerAssets } from "./assets.js";
import { bjsEulerToQuat } from "./bjs-euler.js";
import { ROCK_TRANSFORMS } from "./constants.js";

export interface RockField {
    readonly root: SceneNode;
    readonly pool: HierarchyInstancePool;
}

export function createRocks(assets: RacerAssets): RockField {
    const { root, pool } = instantiateModel(assets.rockTemplate, ROCK_TRANSFORMS.length);
    for (const t of ROCK_TRANSFORMS) {
        const q = bjsEulerToQuat(t.rotation[0], t.rotation[1], t.rotation[2]);
        const trs = mat4Compose(t.position[0], t.position[1], t.position[2], q.x, q.y, q.z, q.w, t.scaling[0], t.scaling[1], t.scaling[2]);
        addHierarchyInstance(pool, trs);
    }
    // `rocks[i].receiveShadows = true` in the playground; they are also shadow casters (wired by world.ts).
    for (const mesh of pool.meshes) {
        mesh.receiveShadows = true;
    }
    return { root, pool };
}

export function addRocksToScene(scene: SceneContext, rocks: RockField): void {
    addToScene(scene, rocks.root);
}
