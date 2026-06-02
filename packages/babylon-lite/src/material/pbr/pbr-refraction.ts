import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { PbrExt } from "./pbr-flags.js";

export async function registerPbrRefraction(scene: SceneContext, engine: EngineContext, register: (ext: PbrExt) => void): Promise<void> {
    const mod = await import("./pbr-transmission-ext.js");
    mod.registerPbrTransmission(scene, engine, register);
}
