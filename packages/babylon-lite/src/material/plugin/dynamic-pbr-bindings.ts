import type { EngineContext } from "../../engine/engine.js";
import type { Renderable } from "../../render/renderable.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { acquireTexture } from "../../resource/texture-acquire.js";
import { releaseTexture } from "../../resource/texture-release.js";
import { retireGpuResources } from "../../engine/gpu-resource-retirement.js";
import { invalidateRenderBundles } from "../../mesh/mesh-factories.js";
import { installPbrBindingDecorator, type ScopedPbrBindingDecorator } from "../pbr/pbr-binding-decorator.js";
import { enablePbrPluginPasses, isPbrIblColorPass, selectPbrPlugins } from "./pbr-plugin-passes.js";
import type { MaterialPlugin } from "./material-plugin.js";

interface BindingState {
    version: number;
    group: GPUBindGroup;
    leases: Texture2D[];
    makeGroup: () => GPUBindGroup;
    disposed: boolean;
}

let _installed = false;

/** @internal Explicit opt-in; normal rendering retains no dynamic-binding implementation. */
export function enableDynamicPbrBindings(): void {
    if (_installed) {
        return;
    }
    _installed = true;
    enablePbrPluginPasses();
    const cache = new WeakMap<Renderable, Map<GPURenderPipeline, BindingState>>();
    const lease = (plugins: readonly MaterialPlugin[]): Texture2D[] => {
        const textures: Texture2D[] = [];
        for (const plugin of plugins) {
            plugin.getActiveTextures?.(textures);
        }
        for (const texture of textures) {
            acquireTexture(texture);
        }
        return textures;
    };
    const release = (engine: EngineContext, textures: readonly Texture2D[]): void => {
        if (textures.length) {
            retireGpuResources(engine, () => {
                for (const texture of textures) {
                    releaseTexture(texture);
                }
            });
        }
    };
    const version = (plugins: readonly MaterialPlugin[]): number => {
        let value = 0;
        for (const plugin of plugins) {
            const next = plugin._bindingVersion!();
            if (!Number.isSafeInteger(next) || next < 0) {
                throw new Error("Dynamic material binding versions must be nonnegative safe integers.");
            }
            value += next;
        }
        if (!Number.isSafeInteger(value)) {
            throw new Error("Combined dynamic material binding version exceeds safe integer range.");
        }
        return value;
    };

    const prepare = (plugins: readonly MaterialPlugin[] | undefined, scope: object): void => {
        if (!plugins) {
            return;
        }
        for (const plugin of plugins) {
            plugin._selectBindingScope?.(scope);
        }
    };
    const decorate: ScopedPbrBindingDecorator = (binding, engine, plugins, fragmentKey, features, features2, makeGroup, drawGroup, disposers, scope) => {
        if (scope) {
            prepare(plugins, scope);
        }
        if (!plugins?.length) {
            return binding;
        }
        const active = selectPbrPlugins(plugins, isPbrIblColorPass(features, features2, fragmentKey.split("|").includes("ibl")));
        const watched = active.filter((plugin) => plugin._bindingVersion);
        if (!watched.length) {
            return binding;
        }
        let entries = cache.get(binding.renderable);
        if (!entries) {
            entries = new Map();
            cache.set(binding.renderable, entries);
        }
        let state = entries.get(binding.pipeline);
        if (!state) {
            const leases = lease(watched);
            let group: GPUBindGroup;
            try {
                group = makeGroup();
            } catch (error) {
                release(engine, leases);
                throw error;
            }
            state = { version: version(watched), group, leases, makeGroup, disposed: false };
            entries.set(binding.pipeline, state);
            const owned = state;
            disposers.push(() => {
                if (owned.disposed) {
                    return;
                }
                owned.disposed = true;
                release(engine, owned.leases);
                owned.leases = [];
                entries!.delete(binding.pipeline);
            });
        }
        state.makeGroup = makeGroup;
        const owned = state;
        const previousUpdate = binding.update;
        return {
            ...binding,
            update(context) {
                if (scope) {
                    prepare(plugins, scope);
                }
                for (const plugin of watched) {
                    plugin._validateDraw?.(context);
                }
                previousUpdate?.(context);
                const next = version(watched);
                if (next === owned.version || owned.disposed) {
                    return;
                }
                const replacementLeases = lease(watched);
                let replacement: GPUBindGroup;
                try {
                    replacement = owned.makeGroup();
                } catch (error) {
                    release(engine, replacementLeases);
                    throw error;
                }
                const old = owned.leases;
                owned.leases = replacementLeases;
                owned.group = replacement;
                owned.version = next;
                release(engine, old);
                invalidateRenderBundles(engine);
            },
            draw(pass) {
                if (owned.disposed) {
                    throw new Error("Dynamic material binding has been disposed.");
                }
                return drawGroup(pass, owned.group);
            },
        };
    };
    decorate._prepare = prepare;
    installPbrBindingDecorator(decorate);
}
