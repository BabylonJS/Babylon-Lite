import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { RenderTask } from "../frame-graph/render-task-base.js";
import type { RenderTargetSignature } from "../engine/render-target.js";

interface PassControl {
    hasDraws(): boolean;
    pause(work: () => void): void;
}

interface TaskPatch {
    original: NonNullable<RenderTask["execute"]>;
    wrapped: NonNullable<RenderTask["execute"]>;
    active: boolean;
}

interface PassOwner {
    references: number;
    scan: () => void;
    tasks: Map<RenderTask, TaskPatch>;
}

let passes: WeakMap<GPURenderPassEncoder | GPURenderBundleEncoder, PassControl> | null = null;
let owners: WeakMap<SceneContext, PassOwner> | null = null;

export function gpsRenderTask(scene: SceneContext, signature: RenderTargetSignature): RenderTask | undefined {
    return scene._frameGraph?._tasks.find((task): task is RenderTask => "_targetSignature" in task && task._targetSignature === signature);
}

export function gpsDefersDraw(scene: SceneContext, signature: RenderTargetSignature): boolean {
    const task = gpsRenderTask(scene, signature);
    return !!task?._targetSignature._depthStencilFormat && !!owners?.get(scene)?.tasks.has(task);
}

export function gpsRefreshPasses(scene: SceneContext): void {
    owners?.get(scene)?.scan();
}

export function gpsPassHasDraws(pass: GPURenderPassEncoder | GPURenderBundleEncoder): boolean | undefined {
    return passes?.get(pass)?.hasDraws();
}

export function gpsWithPassDepth(pass: GPURenderPassEncoder | GPURenderBundleEncoder, work: () => void): boolean {
    const control = passes?.get(pass);
    if (!control) {
        return false;
    }
    control.pause(work);
    return true;
}

function loadDescriptor(descriptor: GPURenderPassDescriptor): GPURenderPassDescriptor {
    const depth = descriptor.depthStencilAttachment;
    return {
        ...descriptor,
        timestampWrites: undefined,
        colorAttachments: Array.from(descriptor.colorAttachments, (attachment) => attachment && { ...attachment, loadOp: "load", storeOp: "store" }),
        depthStencilAttachment: depth && {
            ...depth,
            depthLoadOp: depth.depthReadOnly ? undefined : "load",
            depthStoreOp: depth.depthReadOnly ? undefined : "store",
            stencilLoadOp: depth.stencilLoadOp && !depth.stencilReadOnly ? "load" : undefined,
            stencilStoreOp: depth.stencilStoreOp && !depth.stencilReadOnly ? "store" : undefined,
        },
    };
}

function wrapPass(task: RenderTask, begin: GPUCommandEncoder["beginRenderPass"], descriptor: GPURenderPassDescriptor, frame: { drawn: boolean }): GPURenderPassEncoder {
    if (descriptor.depthStencilAttachment?.depthLoadOp === "clear") {
        frame.drawn = false;
    }
    let current = begin(descriptor);
    const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
    const dynamic = new Map<PropertyKey, unknown[]>();
    let group: unknown[] | undefined;
    const proxy = new Proxy(current, {
        get(_target, key) {
            const value: unknown = Reflect.get(current, key, current);
            if (typeof value !== "function") {
                return value;
            }
            let method = methods.get(key);
            if (!method) {
                method = (...args) => {
                    if (key === "setViewport" || key === "setScissorRect" || key === "setStencilReference" || key === "setBlendConstant" || key === "setPipeline") {
                        dynamic.set(key, args);
                    } else if (key === "setBindGroup" && args[0] === 0) {
                        group = args;
                    } else if (key === "executeBundles") {
                        dynamic.delete("setPipeline");
                        group = undefined;
                        const bundles = Array.from(args[0] as Iterable<GPURenderBundle>);
                        args[0] = bundles;
                        if (bundles.some((bundle) => task._opaqueBindings.length > 0 || !task._ob.includes(bundle))) {
                            frame.drawn = true;
                        }
                    } else if (key === "draw" || key === "drawIndexed" || key === "drawIndirect" || key === "drawIndexedIndirect") {
                        frame.drawn = true;
                    }
                    return Reflect.apply(Reflect.get(current, key, current), current, args);
                };
                methods.set(key, method);
            }
            return method;
        },
    });
    (passes ??= new WeakMap()).set(proxy, {
        hasDraws: () => frame.drawn,
        pause(work) {
            current.end();
            work();
            current = begin(loadDescriptor(descriptor));
            dynamic.forEach((args, key) => Reflect.apply(Reflect.get(current, key, current), current, args));
            if (group) {
                Reflect.apply(current.setBindGroup, current, group);
            }
        },
    });
    return proxy;
}

function execute(task: RenderTask, engine: EngineContext, original: NonNullable<RenderTask["execute"]>): number {
    const encoder = engine._currentEncoder;
    const descriptor = Object.getOwnPropertyDescriptor(encoder, "beginRenderPass");
    const begin = encoder.beginRenderPass.bind(encoder);
    const frame = { drawn: false };
    const wrapped = (pass: GPURenderPassDescriptor): GPURenderPassEncoder => {
        const depth = (task._config.depth ?? task._config.rt)._depthView;
        return depth && pass.depthStencilAttachment?.view === depth ? wrapPass(task, begin, pass, frame) : begin(pass);
    };
    if (!Reflect.set(encoder, "beginRenderPass", wrapped, encoder)) {
        throw new Error("Gaussian point sampling could not instrument the consuming render pass");
    }
    try {
        return original.call(task);
    } finally {
        if (encoder.beginRenderPass === wrapped) {
            if (descriptor) {
                Object.defineProperty(encoder, "beginRenderPass", descriptor);
            } else {
                Reflect.deleteProperty(encoder, "beginRenderPass");
            }
        }
    }
}

/** All pass splitting belongs to the opt-in renderer; the frame graph retains its native execution path. */
export function installGpsPasses(scene: SceneContext): () => void {
    let owner = owners?.get(scene);
    if (!owner) {
        const tasks: PassOwner["tasks"] = new Map();
        owner = {
            references: 0,
            tasks,
            scan() {
                const current = new Set(scene._frameGraph?._tasks ?? []);
                tasks.forEach((patch, task) => {
                    if (!current.has(task)) {
                        patch.active = false;
                        if (task.execute === patch.wrapped) {
                            task.execute = patch.original;
                        }
                        tasks.delete(task);
                    }
                });
                for (const task of scene._frameGraph?._tasks ?? []) {
                    if (!("_targetSignature" in task)) {
                        continue;
                    }
                    const renderTask = task as RenderTask;
                    if (tasks.get(renderTask)?.wrapped === renderTask.execute) {
                        continue;
                    }
                    const previous = tasks.get(renderTask);
                    if (previous) {
                        previous.active = false;
                    }
                    const original = renderTask.execute;
                    if (!original) {
                        continue;
                    }
                    const patch: TaskPatch = {
                        original,
                        active: true,
                        wrapped: () => (patch.active ? execute(renderTask, scene.surface.engine, original) : original.call(renderTask)),
                    };
                    tasks.set(renderTask, patch);
                    renderTask.execute = patch.wrapped;
                }
            },
        };
        (owners ??= new WeakMap()).set(scene, owner);
        scene._beforeRender.push(owner.scan);
    }
    owner.references++;
    owner.scan();
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        if (--owner.references !== 0) {
            return;
        }
        owner.tasks.forEach((patch, task) => {
            patch.active = false;
            if (task.execute === patch.wrapped) {
                task.execute = patch.original;
            }
        });
        const index = scene._beforeRender.indexOf(owner.scan);
        if (index >= 0) {
            scene._beforeRender.splice(index, 1);
        }
        owners?.delete(scene);
    };
}
