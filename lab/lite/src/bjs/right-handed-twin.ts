// Shared by the right-handed twin references (scenes 321+): makes every Babylon.js scene created
// after this module evaluates right-handed, as if each one set `scene.useRightHandedSystem = true`
// right after construction. A twin reference imports this module, then the original scene's
// reference unchanged, so the two can never drift apart.
import { Scene } from "@babylonjs/core/scene";

Object.defineProperty(Scene.prototype, "_useRightHandedSystem", {
    configurable: true,
    get: () => true,
    set: () => {},
});
