import type { EngineContext } from "../../engine/engine.js";
import type { DrawUpdateContext, Renderable } from "../../render/renderable.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { acquireTexture } from "../../resource/texture-acquire.js";
import { releaseTexture } from "../../resource/texture-release.js";
import { retireGpuResources } from "../../engine/gpu-resource-retirement.js";
import { invalidateRenderBundles } from "../../mesh/mesh-factories.js";
import { installPbrBindingDecorator, type ScopedPbrBindingDecorator } from "../pbr/pbr-binding-decorator.js";
import { enablePbrPluginPasses, isPbrIblColorPass, selectPbrPlugins } from "./pbr-plugin-passes.js";
import type { MaterialPlugin } from "./material-plugin.js";

interface BindingState {
    versions: number[];
    group: GPUBindGroup;
    leases: Texture2D[];
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
    const cache = new WeakMap<Renderable, Map<GPURenderPipeline, WeakMap<DrawUpdateContext, BindingState>>>();
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
        let contexts = entries.get(binding.pipeline);
        if (!contexts) {
            contexts = new WeakMap();
            entries.set(binding.pipeline, contexts);
        }
        const passStates = contexts;
        let owned: BindingState | undefined;
        const previousUpdate = binding.update;
        return {
            ...binding,
            update(context) {
                if (scope) {
                    prepare(plugins, scope);
                }
                for (const plugin of watched) {
                    plugin._prepareDraw?.(context);
                }
                previousUpdate?.(context);
                let state = passStates.get(context);
                if (!state) {
                    const leases = lease(watched);
                    let group: GPUBindGroup;
                    try {
                        group = makeGroup();
                    } catch (error) {
                        release(engine, leases);
                        throw error;
                    }
                    state = { versions: watched.map((plugin) => plugin._bindingVersion!()), group, leases, disposed: false };
                    passStates.set(context, state);
                    const held = state;
                    disposers.push(() => {
                        if (held.disposed) {
                            return;
                        }
                        held.disposed = true;
                        release(engine, held.leases);
                        held.leases = [];
                        passStates.delete(context);
                    });
                    invalidateRenderBundles(engine);
                }
                owned = state;
                let changed = false;
                for (let i = 0; i < watched.length; i++) {
                    if (state.versions[i] !== watched[i]!._bindingVersion!()) {
                        changed = true;
                        break;
                    }
                }
                if (!changed || state.disposed) {
                    return;
                }
                const replacementLeases = lease(watched);
                let replacement: GPUBindGroup;
                try {
                    replacement = makeGroup();
                } catch (error) {
                    release(engine, replacementLeases);
                    throw error;
                }
                const old = state.leases;
                state.leases = replacementLeases;
                state.group = replacement;
                for (let i = 0; i < watched.length; i++) {
                    state.versions[i] = watched[i]!._bindingVersion!();
                }
                release(engine, old);
                invalidateRenderBundles(engine);
            },
            draw(pass) {
                if (!owned || owned.disposed) {
                    throw new Error("Dynamic material binding must be updated before drawing and must not be disposed.");
                }
                return drawGroup(pass, owned.group);
            },
        };
    };
    decorate._prepare = prepare;
    installPbrBindingDecorator(decorate);
}
