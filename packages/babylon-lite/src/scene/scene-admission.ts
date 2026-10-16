import type { EngineContext } from "../engine/engine.js";

/** @internal Install an opt-in membership admission policy. */
export function installSceneAdmission(engine: EngineContext, policy: EngineContext["_admitSceneEntity"]): void {
    if (policy) {
        engine._admitSceneEntity = policy;
    } else {
        delete engine._admitSceneEntity;
    }
}
