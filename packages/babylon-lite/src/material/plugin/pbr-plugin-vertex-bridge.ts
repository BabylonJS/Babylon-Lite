import type { PbrExt } from "../pbr/pbr-flags.js";
import type { PbrMaterialProps } from "../pbr/pbr-material.js";
import type { MaterialPlugin } from "./material-plugin.js";
import { bindPluginTextures, collectPluginTextures, enabledPlugins, writePluginUbo } from "./plugin-bridge-shared.js";
import { _allocatePbrPluginIndex, _getPbrPluginFragment, _registerPbrPluginFragment, _setActivePbrPluginExt } from "./pbr-plugin-registry.js";
import { buildPbrVertexPluginFragment, pbrVertexPluginSignature } from "./pbr-plugin-vertex-data.js";

let signatureToIndex: Map<string, number> | null = null;

function indexFor(plugins: readonly MaterialPlugin[]): number {
    const signature = pbrVertexPluginSignature(plugins);
    const map = (signatureToIndex ??= new Map());
    let index = map.get(signature);
    if (index === undefined) {
        index = _allocatePbrPluginIndex();
        _registerPbrPluginFragment(index, buildPbrVertexPluginFragment(plugins, index));
        map.set(signature, index);
    }
    return index;
}

const pbrVertexPluginExt: PbrExt = {
    id: "plugin",
    phase: "fragment",
    detect(material) {
        const pbrMaterial = material as PbrMaterialProps;
        const plugins = pbrMaterial.plugins;
        pbrMaterial._preparedPlugins = plugins?.length ? enabledPlugins(plugins) : undefined;
        pbrMaterial._pi = plugins?.length ? indexFor(plugins) : 0;
        return { f: 0, f2: 0 };
    },
    frag(context) {
        const index = context._pi ?? 0;
        if (!index) {
            return null;
        }
        const fragment = _getPbrPluginFragment(index);
        if (!fragment) {
            throw new Error("PBR material plugin vertex signature is not registered.");
        }
        return fragment;
    },
    writeUbo(data, material, offsets) {
        const plugins = (material as PbrMaterialProps)._preparedPlugins;
        if (plugins?.length) {
            writePluginUbo(plugins, data, offsets);
        }
    },
    bind(context, entries, binding) {
        const plugins = (context._material as PbrMaterialProps)._preparedPlugins;
        return plugins?.length ? bindPluginTextures(plugins, entries, binding) : binding;
    },
    textures(material, out) {
        const plugins = (material as PbrMaterialProps)._preparedPlugins;
        if (plugins?.length) {
            collectPluginTextures(plugins, out);
        }
    },
};

/** @internal Register the PBR bridge that supports plugin-defined vertex resources. */
export function registerPbrVertexPlugins(register: (extension: PbrExt) => void): void {
    _setActivePbrPluginExt(pbrVertexPluginExt);
    register(pbrVertexPluginExt);
}
