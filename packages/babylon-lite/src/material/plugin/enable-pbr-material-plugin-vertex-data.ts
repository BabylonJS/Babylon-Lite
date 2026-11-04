import { _registerPbrExt } from "../pbr/pbr-flags.js";
import { registerPbrVertexPlugins } from "./pbr-plugin-vertex-bridge.js";

/** Enable PBR material plugins that declare custom varyings or vertex-visible uniforms, textures, and samplers. */
export function enablePbrMaterialPluginVertexData(): void {
    registerPbrVertexPlugins(_registerPbrExt);
}
