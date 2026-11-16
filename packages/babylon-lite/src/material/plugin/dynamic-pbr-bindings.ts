import type { EngineContext } from "../../engine/engine.js";
import type { DrawBinding, DrawUpdateContext, Renderable } from "../../render/renderable.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { acquireTexture } from "../../resource/texture-acquire.js";
import { releaseTexture } from "../../resource/texture-release.js";
import { retireGpuResources } from "../../engine/gpu-resource-retirement.js";
import { invalidateRenderBundles } from "../../mesh/mesh-factories.js";
import { installPbrBindingDecorator, type ScopedPbrBindingDecorator } from "../pbr/pbr-binding-decorator.js";
import { enablePbrPluginPasses, isPbrIblColorPass, selectPbrPlugins } from "./pbr-plugin-passes.js";
import type { MaterialPlugin } from "./material-plugin.js";
import { installDrawBindingLifecycle } from "../../render/draw-binding-lifecycle.js";

interface BindingState {
    versions: number[];
    group: GPUBindGroup;
    leases: Texture2D[];
    disposed: boolean;
    users: number;
    dispose(): void;
}

interface RenderableStates {
    pipelines: Map<GPURenderPipeline, WeakMap<DrawUpdateContext, BindingState>>;
    states: Set<BindingState>;
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
    const cache = new WeakMap<Renderable, RenderableStates>();
    const retirements = new WeakMap<DrawBinding, () => void>();
    installDrawBindingLifecycle({
        _retire(lists, retained) {
            const keep = retained ? new Set(retained.flat()) : undefined;
            for (const list of lists) {
                for (const binding of list) {
                    if (keep?.has(binding)) {
                        continue;
                    }
                    const retire = retirements.get(binding);
                    retirements.delete(binding);
                    retire?.();
                }
            }
        },
        _setProjectionAspect(context, aspect) {
            context._projectionAspect = aspect;
        },
    });
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
        const renderable = binding.renderable;
        let entries = cache.get(renderable);
        if (!entries) {
            entries = { pipelines: new Map(), states: new Set(), disposed: false };
            cache.set(renderable, entries);
            const lifetime = entries;
            disposers.push(() => {
                lifetime.disposed = true;
                for (const state of lifetime.states) {
                    state.dispose();
                }
                cache.delete(renderable);
            });
        }
        const lifetime = entries;
        let contexts = entries.pipelines.get(binding.pipeline);
        if (!contexts) {
            contexts = new WeakMap();
            entries.pipelines.set(binding.pipeline, contexts);
        }
        const passStates = contexts;
        let owned: BindingState | undefined;
        let retired = false;
        const releaseOwned = (): void => {
            const previous = owned;
            owned = undefined;
            if (previous && --previous.users === 0) {
                previous.dispose();
            }
        };
        const previousUpdate = binding.update;
        const decorated: DrawBinding = {
            ...binding,
            update(context) {
                if (retired || lifetime.disposed) {
                    throw new Error("Dynamic material binding has been retired.");
                }
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
                    const held: BindingState = {
                        versions: watched.map((plugin) => plugin._bindingVersion!()),
                        group,
                        leases,
                        disposed: false,
                        users: 0,
                        dispose() {
                            if (held.disposed) {
                                return;
                            }
                            held.disposed = true;
                            release(engine, held.leases);
                            held.leases = [];
                            passStates.delete(context);
                            lifetime.states.delete(held);
                        },
                    };
                    state = held;
                    passStates.set(context, state);
                    lifetime.states.add(state);
                    invalidateRenderBundles(engine);
                }
                if (owned !== state) {
                    releaseOwned();
                    state.users++;
                    owned = state;
                }
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
        retirements.set(decorated, () => {
            retired = true;
            releaseOwned();
        });
        return decorated;
    };
    decorate._prepare = prepare;
    installPbrBindingDecorator(decorate);
}
