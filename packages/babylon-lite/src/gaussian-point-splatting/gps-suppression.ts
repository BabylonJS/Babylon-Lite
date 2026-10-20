import type { SceneContext } from "../scene/scene-core.js";
import type { Renderable } from "../render/renderable.js";
import type { GaussianPointSplatting } from "./gps-state.js";

type Pass = GPURenderPassEncoder | GPURenderBundleEncoder;

interface Candidate {
    original: Renderable["bind"];
    replacement: Renderable["bind"];
    target: GaussianPointSplatting | null;
    active: boolean;
}

interface Tracker {
    add(gps: GaussianPointSplatting, renderable: Renderable): void;
    remove(gps: GaussianPointSplatting): void;
}

let trackers: WeakMap<SceneContext, Tracker> | null = null;

function createTracker(scene: SceneContext): Tracker {
    const targets = new Map<GaussianPointSplatting, Renderable>();
    const candidates = new Map<Renderable, Candidate>();
    let rejected = new WeakSet<Renderable>();
    const restore = (classic: Renderable, candidate: Candidate): void => {
        candidate.active = false;
        if (classic.bind === candidate.replacement) {
            classic.bind = candidate.original;
            scene._renderableVersion++;
        }
        candidates.delete(classic);
    };
    const wrap = (classic: Renderable, known: GaussianPointSplatting | null): void => {
        const original = classic.bind;
        const candidate: Candidate = {
            original,
            target: known,
            active: true,
            replacement(engine, signature) {
                const binding = original.call(this, engine, signature);
                const draw = binding.draw;
                const proxies = new WeakMap<Pass, Pass>();
                let issued = false;
                let suppressed = false;
                return {
                    ...binding,
                    draw(pass, currentEngine) {
                        if (!candidate.active || (candidate.target && !candidate.target.colorRenderMode)) {
                            return draw.call(binding, pass, currentEngine);
                        }
                        let proxy = proxies.get(pass);
                        if (!proxy) {
                            proxy = new Proxy(pass, {
                                get(object, key) {
                                    const value: unknown = Reflect.get(object, key, object);
                                    if (key === "setVertexBuffer") {
                                        return (...args: Parameters<Pass["setVertexBuffer"]>) => {
                                            if (!candidate.target && args[1]) {
                                                for (const gps of targets.keys()) {
                                                    const mesh = gps._target;
                                                    if ("_gs" in mesh && mesh._gs._splatIndexBuffer === args[1]) {
                                                        candidate.target = gps;
                                                        break;
                                                    }
                                                }
                                            }
                                            return object.setVertexBuffer(...args);
                                        };
                                    }
                                    if (key === "draw" || key === "drawIndexed" || key === "drawIndirect" || key === "drawIndexedIndirect") {
                                        return (...args: unknown[]) => {
                                            issued = true;
                                            if (candidate.target?.colorRenderMode && !candidate.target._disabled) {
                                                suppressed = true;
                                                return;
                                            }
                                            return Reflect.apply(value as (...values: unknown[]) => unknown, object, args);
                                        };
                                    }
                                    return typeof value === "function" ? value.bind(object) : value;
                                },
                            });
                            proxies.set(pass, proxy);
                        }
                        issued = suppressed = false;
                        // Run the original draw even when suppressed: streams notify bootstrap completion here.
                        const count = draw.call(binding, proxy, currentEngine);
                        if (issued && !candidate.target) {
                            rejected.add(classic);
                            restore(classic, candidate);
                        }
                        return suppressed ? 0 : count;
                    },
                };
            },
        };
        candidates.set(classic, candidate);
        classic.bind = candidate.replacement;
        scene._renderableVersion++;
    };
    const refresh = (): void => {
        for (const [classic, candidate] of candidates) {
            if (!scene._renderables.includes(classic)) {
                restore(classic, candidate);
            }
        }
        const handles = [...targets.keys()];
        const pointRenderables = [...targets.values()];
        const staticTargets = handles.some((gps) => "_gs" in gps._target);
        for (const classic of scene._renderables) {
            if (pointRenderables.includes(classic)) {
                continue;
            }
            const known = handles.find((gps) => "_renderable" in gps._target && gps._target._renderable === classic) ?? null;
            const candidate = candidates.get(classic);
            if (candidate) {
                candidate.target ??= known;
                continue;
            }
            if (!known && rejected.has(classic)) {
                continue;
            }
            if (known || (staticTargets && classic.order === 200 && classic.isTransparent)) {
                wrap(classic, known);
            }
        }
    };
    scene._beforeRender.push(refresh);
    return {
        add(gps, renderable) {
            targets.set(gps, renderable);
            rejected = new WeakSet();
            refresh();
        },
        remove(gps) {
            targets.delete(gps);
            for (const [classic, candidate] of candidates) {
                if (!targets.size || candidate.target === gps) {
                    rejected.add(classic);
                    restore(classic, candidate);
                }
            }
            if (!targets.size) {
                const index = scene._beforeRender.indexOf(refresh);
                if (index >= 0) {
                    scene._beforeRender.splice(index, 1);
                }
                trackers?.delete(scene);
            }
        },
    };
}

/** @internal Observe classic draws without adding metadata or branches to classic GS modules. */
export function installGpsDrawSuppression(scene: SceneContext, gps: GaussianPointSplatting, renderable: Renderable): () => void {
    trackers ??= new WeakMap();
    let tracker = trackers.get(scene);
    if (!tracker) {
        tracker = createTracker(scene);
        trackers.set(scene, tracker);
    }
    tracker.add(gps, renderable);
    return () => tracker.remove(gps);
}
