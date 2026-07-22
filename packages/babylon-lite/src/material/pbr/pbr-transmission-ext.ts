import type { SceneContext } from "../../scene/scene.js";
import type { EngineContext } from "../../engine/engine.js";
import type { PbrExt } from "./pbr-flags.js";
import { _t, enableSceneTransmission } from "../../frame-graph/transmission.js";
import { makeRefractionRttExt } from "./fragments/refraction-rtt-fragment.js";

export function registerPbrTransmission(scene: SceneContext, engine: EngineContext, register: (ext: PbrExt) => void, dispersionSampleWgsl?: string): void {
    (scene as SceneContext & { p?: (value: ReturnType<typeof _t>) => boolean }).p?.(_t(scene, engine)) || enableSceneTransmission(scene, engine);
    register(makeRefractionRttExt(dispersionSampleWgsl));
}
