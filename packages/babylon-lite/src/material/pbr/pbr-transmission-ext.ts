import type { SceneContext } from "../../scene/scene.js";
import type { EngineContext } from "../../engine/engine.js";
import type { PbrExt } from "./pbr-flags.js";
import { enableSceneTransmission } from "../../frame-graph/transmission.js";
import { makeRefractionRttExt } from "./fragments/refraction-rtt-fragment.js";

export function registerPbrTransmission(scene: SceneContext, engine: EngineContext, register: (ext: PbrExt) => void, dispersionSampleWgsl?: string): void {
    enableSceneTransmission(scene, engine);
    register(makeRefractionRttExt(dispersionSampleWgsl));
}
