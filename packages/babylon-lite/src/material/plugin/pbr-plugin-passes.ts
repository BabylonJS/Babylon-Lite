import type { PbrExt } from "../pbr/pbr-flags.js";
import type { PbrMaterialProps } from "../pbr/pbr-material.js";
import type { MaterialPlugin } from "./material-plugin.js";
import { PBR_HAS_ALPHA_BLEND, PBR2_HAS_REFRACTION, PBR2_NO_COLOR_OUTPUT, PBR2_ESM_SHADOW_OUTPUT } from "../pbr/pbr-flag-bits.js";
import { _allocatePbrPluginIndex, _getActivePbrPluginExt, _getPbrPluginFragment, _registerPbrPluginFragment, _setActivePbrPluginExt } from "./pbr-plugin-registry.js";
import { pbrPluginExt } from "./pbr-plugin-bridge.js";
import { installPbrPluginDecorator } from "./pbr-plugin-decorator.js";
import { bindPluginTextures, collectPluginTextures } from "./plugin-bridge-shared.js";

interface PluginPass {
    other: number;
    names: readonly string[];
}

let passes: Map<number, PluginPass> | null = null;

/** @internal Immutable shader identity metadata, never material instances. */
export function pbrPluginSignatureContains(index: number, name: string): boolean {
    return passes?.get(index)?.names.includes(name) ?? false;
}

/** @internal Match fragment selection and resource binding for diffuse-environment plugins. */
export function isPbrIblColorPass(features: number, features2: number, hasIbl: boolean): boolean {
    const geometryOutput = 1 << 21;
    const unlit = 1 << 8;
    return hasIbl && (features & PBR_HAS_ALPHA_BLEND) === 0 && (features2 & (geometryOutput | unlit | PBR2_HAS_REFRACTION | PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT)) === 0;
}

/** @internal Construction-only selection; ordinary plugin users do not retain this policy. */
export function selectPbrPlugins(plugins: readonly MaterialPlugin[], iblPass: boolean): readonly MaterialPlugin[] {
    return iblPass ? plugins : plugins.filter((plugin) => !plugin._pbrIblOnly);
}

/** @internal Decorate either plugin bridge only after a pass-specific feature opts in. */
export function enablePbrPluginPasses(): void {
    if (passes) {
        return;
    }
    const metadata = (passes = new Map());
    const wrappers = new WeakMap<PbrExt, PbrExt>();
    const variants = new Map<string, number>();
    installPbrPluginDecorator((extension) => {
        const existing = wrappers.get(extension);
        if (existing) {
            return existing;
        }
        const decorated: PbrExt = {
            ...extension,
            detect(material) {
                const result = extension.detect!(material);
                const pbr = material as PbrMaterialProps;
                const plugins = pbr._preparedPlugins;
                if (!plugins?.some((plugin) => plugin._pbrIblOnly)) {
                    return result;
                }
                const full = pbr._pi!;
                const signature = `${full}:${plugins.map((plugin) => Number(!!plugin._pbrIblOnly)).join("")}`;
                let index = variants.get(signature);
                if (index === undefined) {
                    // Reuse the active bridge's signature machinery, including vertex-resource plugins.
                    const filtered = Object.create(pbr) as PbrMaterialProps;
                    filtered.plugins = [...selectPbrPlugins(plugins, false)];
                    extension.detect!(filtered);
                    index = _allocatePbrPluginIndex();
                    _registerPbrPluginFragment(index, _getPbrPluginFragment(full)!);
                    metadata.set(index, { other: filtered._pi!, names: plugins.map((plugin) => plugin.name) });
                    variants.set(signature, index);
                }
                pbr._pi = index;
                return result;
            },
            frag(context) {
                const pass = metadata.get(context._pi ?? 0);
                return pass && !isPbrIblColorPass(context._features, context._features2, context._hasIbl)
                    ? pass.other
                        ? extension.frag!({ ...context, _pi: pass.other })
                        : null
                    : extension.frag!(context);
            },
            bind(context, entries, binding) {
                const plugins = (context._material as PbrMaterialProps)._preparedPlugins;
                return plugins?.length
                    ? bindPluginTextures(selectPbrPlugins(plugins, isPbrIblColorPass(context._features, context._features2, !!context._env)), entries, binding)
                    : binding;
            },
            textures(material, out) {
                const plugins = (material as PbrMaterialProps)._preparedPlugins;
                if (plugins?.length) {
                    // Dynamic generations are leased by the binding decorator, not by the mesh.
                    collectPluginTextures(
                        plugins.filter((plugin) => !plugin._bindingVersion),
                        out
                    );
                }
            },
        };
        wrappers.set(extension, decorated);
        return decorated;
    });
    _setActivePbrPluginExt(_getActivePbrPluginExt(pbrPluginExt));
}
