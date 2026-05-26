import type { SceneContextInternal } from "../../scene/scene.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { PbrExt } from "./pbr-flags.js";
import { enableSceneTransmission } from "../../frame-graph/transmission.js";
import { refractionRttExt } from "./fragments/refraction-rtt-fragment.js";

export function registerPbrTransmission(scene: SceneContextInternal, engine: EngineContextInternal, register: (ext: PbrExt) => void): void {
    enableSceneTransmission(scene, engine);
    register(refractionRttExt);
}
