import type { EngineContext } from "../engine/engine.js";
import { buildRenderTarget, type RenderTarget } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene-core.js";
import { addPassDependencies } from "./pass.js";
import type { Task } from "./task.js";
import { createTextureTaskPass } from "./texture-task-pass.js";

/** Inputs matching Babylon.js FrameGraphClearTextureTask, using concrete render targets. */
export interface ClearTextureTaskConfig {
    name?: string;
    targetTexture?: RenderTarget | RenderTarget[];
    depthTexture?: RenderTarget;
    color?: GPUColorDict;
    clearColor?: boolean;
    convertColorToLinearSpace?: boolean;
    clearDepth?: boolean;
    clearStencil?: boolean;
    stencilValue?: number;
}

/** Clear selected color, depth, and stencil aspects in place. Input targets are borrowed. */
export interface ClearTextureTask extends Task {
    targetTexture: RenderTarget | RenderTarget[] | undefined;
    depthTexture: RenderTarget | undefined;
    color: GPUColorDict;
    clearColor: boolean;
    convertColorToLinearSpace: boolean;
    clearDepth: boolean;
    clearStencil: boolean;
    stencilValue: number;
    /** First color target, or undefined for a depth-only clear. */
    readonly outputTexture: RenderTarget | undefined;
    readonly outputDepthTexture: RenderTarget | undefined;
}

/** Create a drawless clear task with independently selectable attachment aspects. */
export function createClearTextureTask(config: ClearTextureTaskConfig, engine: EngineContext, scene?: SceneContext): ClearTextureTask {
    let targets: RenderTarget[] = [];
    let depthTarget: RenderTarget | undefined;
    let attachments: GPURenderPassColorAttachment[] = [];
    let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    let hasDepth = false;
    let hasStencil = false;
    let descriptor: GPURenderPassDescriptor | null = null;
    const clearValue: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 };
    const task: ClearTextureTask = {
        name: config.name ?? "clear-texture",
        engine,
        scene,
        _passes: [],
        targetTexture: config.targetTexture,
        depthTexture: config.depthTexture,
        color: config.color ?? { r: 0.2, g: 0.2, b: 0.3, a: 1 },
        clearColor: config.clearColor ?? true,
        convertColorToLinearSpace: config.convertColorToLinearSpace ?? false,
        clearDepth: config.clearDepth ?? false,
        clearStencil: config.clearStencil ?? false,
        stencilValue: config.stencilValue ?? 0,
        get outputTexture(): RenderTarget | undefined {
            return Array.isArray(task.targetTexture) ? task.targetTexture[0] : task.targetTexture;
        },
        get outputDepthTexture(): RenderTarget | undefined {
            return task.depthTexture;
        },
        record(): void {
            reset();
            targets = task.targetTexture === undefined ? [] : Array.isArray(task.targetTexture) ? task.targetTexture.slice() : [task.targetTexture];
            depthTarget = task.depthTexture;
            if ((!targets.length && !depthTarget) || (Array.isArray(task.targetTexture) && !targets.length)) {
                throw new Error(`ClearTextureTask "${task.name}": targetTexture or depthTexture is required; color target arrays must not be empty.`);
            }
            const pass = createTextureTaskPass(task, initialize, execute, reset);
            addPassDependencies(pass, targets);
            if (depthTarget) {
                addPassDependencies(pass, depthTarget);
            }
        },
        dispose(): void {
            for (const pass of task._passes) {
                pass._dispose();
            }
            task._passes.length = 0;
            reset();
        },
    };

    function reset(): void {
        descriptor = null;
        targets = [];
        depthTarget = undefined;
        attachments = [];
        depthAttachment = undefined;
        hasDepth = hasStencil = false;
    }

    function initialize(): void {
        const first = targets[0] ?? depthTarget!;
        const colorTextures = new Set<GPUTexture>();
        for (const target of targets) {
            if (!target._descriptor.format) {
                throw new Error(`ClearTextureTask "${task.name}": targetTexture must have a color attachment.`);
            }
            if (target._syncEager || !target._colorView) {
                buildRenderTarget(target, engine);
            }
            const swapchain = target === engine.scRT || engine.surfaces?.some((surface) => target === surface.scRT);
            if (!target._colorView && !swapchain) {
                throw new Error(`ClearTextureTask "${task.name}": targetTexture must have a color attachment.`);
            }
            if (target._colorTexture) {
                if (colorTextures.has(target._colorTexture)) {
                    throw new Error(`ClearTextureTask "${task.name}": color attachments must reference distinct textures.`);
                }
                colorTextures.add(target._colorTexture);
            }
        }
        if (depthTarget) {
            const format = depthTarget._descriptor.dFormat;
            if (!format) {
                throw new Error(`ClearTextureTask "${task.name}": depthTexture must have a depth/stencil attachment.`);
            }
            if (depthTarget._syncEager || !depthTarget._depthView) {
                buildRenderTarget(depthTarget, engine);
            }
            if (!depthTarget._depthView) {
                throw new Error(`ClearTextureTask "${task.name}": depthTexture must have a depth/stencil attachment.`);
            }
            hasDepth = format !== "stencil8";
            hasStencil = format === "stencil8" || format === "depth24plus-stencil8" || format === "depth32float-stencil8";
        }
        for (const target of targets) {
            validateCompatibility(first, target);
        }
        if (depthTarget) {
            validateCompatibility(first, depthTarget);
        }
        if (targets.length > engine._device.limits.maxColorAttachments) {
            throw new Error(`ClearTextureTask "${task.name}": too many color attachments.`);
        }
        attachments = targets.map((target) => ({
            view: target._colorView!,
            loadOp: "load",
            storeOp: "store",
            clearValue,
        }));
        depthAttachment = depthTarget
            ? {
                  view: depthTarget._depthView!,
                  ...(hasDepth ? { depthClearValue: depthTarget._descriptor.depthClearValue ?? 0, depthLoadOp: "load" as const, depthStoreOp: "store" as const } : {}),
                  ...(hasStencil ? { stencilClearValue: 0, stencilLoadOp: "load" as const, stencilStoreOp: "store" as const } : {}),
              }
            : undefined;
        descriptor = { label: task.name, colorAttachments: attachments, depthStencilAttachment: depthAttachment };
    }

    function validateCompatibility(first: RenderTarget, target: RenderTarget): void {
        if (first._width !== target._width || first._height !== target._height || first._descriptor.samples !== target._descriptor.samples) {
            throw new Error(`ClearTextureTask "${task.name}": attachments must have matching dimensions and sample counts.`);
        }
    }

    function execute(): number {
        if (!descriptor) {
            throw new Error(`ClearTextureTask "${task.name}": build the frame graph before execution.`);
        }
        if (!(task.clearColor && attachments.length) && !(task.clearDepth && hasDepth) && !(task.clearStencil && hasStencil)) {
            return 0;
        }
        if (task.clearColor && attachments.length) {
            const color = task.color;
            clearValue.r = task.convertColorToLinearSpace ? color.r ** 2.2 : color.r;
            clearValue.g = task.convertColorToLinearSpace ? color.g ** 2.2 : color.g;
            clearValue.b = task.convertColorToLinearSpace ? color.b ** 2.2 : color.b;
            clearValue.a = color.a;
        }
        for (let i = 0; i < attachments.length; i++) {
            const attachment = attachments[i]!;
            const view = targets[i]!._colorView;
            if (!view) {
                throw new Error(`ClearTextureTask "${task.name}": targetTexture has no live color attachment.`);
            }
            attachment.view = view;
            attachment.loadOp = task.clearColor ? "clear" : "load";
        }
        if (depthAttachment) {
            const view = depthTarget!._depthView;
            if (!view) {
                throw new Error(`ClearTextureTask "${task.name}": depthTexture has no live depth/stencil attachment.`);
            }
            depthAttachment.view = view;
            if (hasDepth) {
                depthAttachment.depthLoadOp = task.clearDepth ? "clear" : "load";
                depthAttachment.depthClearValue = depthTarget!._descriptor.depthClearValue ?? 0;
            }
            if (hasStencil) {
                depthAttachment.stencilLoadOp = task.clearStencil ? "clear" : "load";
                depthAttachment.stencilClearValue = task.stencilValue;
            }
        }
        engine._currentEncoder.beginRenderPass(descriptor).end();
        return 0;
    }
    return task;
}
