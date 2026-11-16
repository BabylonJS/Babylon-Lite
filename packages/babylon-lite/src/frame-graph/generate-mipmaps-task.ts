import type { EngineContext } from "../engine/engine.js";
import { TU } from "../engine/gpu-flags.js";
import { buildRenderTarget, type RenderTarget } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene-core.js";
import { supportsMipmapFormat } from "../texture/mipmap-format.js";
import { prepareMipmaps, recordPreparedMipmaps, type PreparedMipmapLevel } from "../texture/mipmap-preparation.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { addPassDependencies } from "./pass.js";
import type { Task } from "./task.js";
import { createTextureTaskPass } from "./texture-task-pass.js";

/** Inputs matching Babylon.js FrameGraphGenerateMipMapsTask, using concrete textures. */
export interface GenerateMipMapsTaskConfig<T extends RenderTarget | Texture2D = RenderTarget | Texture2D> {
    name?: string;
    targetTexture: T;
}

/** Regenerate an existing texture's mip chain in place without taking texture ownership. */
export interface GenerateMipMapsTask<T extends RenderTarget | Texture2D = RenderTarget | Texture2D> extends Task {
    targetTexture: T;
    readonly outputTexture: T;
}

/** Create a task that records prepared mipmap blits into the current frame encoder. */
export function createGenerateMipMapsTask<T extends RenderTarget | Texture2D>(
    config: GenerateMipMapsTaskConfig<T>,
    engine: EngineContext,
    scene?: SceneContext
): GenerateMipMapsTask<T> {
    let prepared: PreparedMipmapLevel[] | null = null;
    let boundTexture: GPUTexture | null = null;
    const task: GenerateMipMapsTask<T> = {
        name: config.name ?? "generate-mipmaps",
        engine,
        scene,
        _passes: [],
        targetTexture: config.targetTexture,
        get outputTexture(): T {
            return task.targetTexture;
        },
        record(): void {
            prepared = null;
            boundTexture = null;
            if (!task.targetTexture) {
                throw new Error(`GenerateMipMapsTask "${task.name}": targetTexture is required.`);
            }
            const target = task.targetTexture;
            const pass = createTextureTaskPass(
                task,
                () => initialize(target),
                () => {
                    if (!prepared) {
                        throw new Error(`GenerateMipMapsTask "${task.name}": build the frame graph before execution.`);
                    }
                    const liveTexture = "_descriptor" in target ? target._colorTexture : target.texture;
                    if (task.targetTexture !== target || liveTexture !== boundTexture) {
                        throw new Error(`GenerateMipMapsTask "${task.name}": targetTexture changed or was disposed; rebuild the frame graph before execution.`);
                    }
                    recordPreparedMipmaps(engine._currentEncoder, prepared);
                    return prepared.length;
                },
                () => {
                    prepared = null;
                    boundTexture = null;
                }
            );
            if ("_descriptor" in target) {
                addPassDependencies(pass, target);
            }
        },
        dispose(): void {
            for (const pass of task._passes) {
                pass._dispose();
            }
            task._passes.length = 0;
            prepared = null;
            boundTexture = null;
        },
    };

    function initialize(target: RenderTarget | Texture2D): void {
        let texture: GPUTexture | null;
        if ("_descriptor" in target) {
            if (target === engine.scRT || engine.surfaces?.some((surface) => target === surface.scRT)) {
                throw new Error(`GenerateMipMapsTask "${task.name}": targetTexture cannot be a swapchain target.`);
            }
            if (target._syncEager || !target._colorTexture) {
                buildRenderTarget(target, engine);
            }
            texture = target._colorTexture;
        } else {
            texture = target.texture;
        }
        if (
            !texture ||
            texture.dimension !== "2d" ||
            texture.sampleCount !== 1 ||
            !supportsMipmapFormat(engine, texture.format) ||
            (texture.usage & (TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT)) !== (TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT)
        ) {
            throw new Error(
                `GenerateMipMapsTask "${task.name}": targetTexture must be a single-sample, filterable, renderable 2D color texture with sampling and render-attachment usage.`
            );
        }
        if (texture.mipLevelCount <= 1 && (texture.width > 1 || texture.height > 1)) {
            throw new Error(`GenerateMipMapsTask "${task.name}": targetTexture must have mipmaps allocated.`);
        }
        const levels: PreparedMipmapLevel[] = [];
        for (let layer = 0; layer < texture.depthOrArrayLayers; layer++) {
            levels.push(...prepareMipmaps(engine, texture, layer));
        }
        prepared = levels;
        boundTexture = texture;
    }
    return task;
}
