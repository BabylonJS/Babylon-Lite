import type { SceneContext } from "./scene-core.js";

/** @internal Opt-in scene membership admission seam. */
export let sceneAdmission: ((scene: SceneContext, entity: object) => boolean) | undefined;

/** @internal Install an opt-in membership admission policy. */
export function installSceneAdmission(policy: NonNullable<typeof sceneAdmission>): void {
    sceneAdmission = policy;
}
