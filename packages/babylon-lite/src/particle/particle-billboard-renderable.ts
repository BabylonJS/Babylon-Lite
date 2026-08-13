import { F32 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import type { Renderable } from "../render/renderable.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { _attachBillboardCustomShader, createBillboardCustomShader } from "../sprite/billboard-custom-shader.js";
import {
    BILLBOARD_SYSTEM_UBO_BYTES,
    buildBillboardSystemUbo,
    createBillboardPipelineCache,
    createBillboardSystemBindGroup,
    getOrCreateBillboardPipeline,
    resetBillboardPipelineCache,
    writeBillboardSystemUboIfDirty,
} from "../sprite/billboard-pipeline.js";
import { buildBillboardRenderable } from "../sprite/billboard-renderable.js";
import type { FacingBillboardSpriteSystem } from "../sprite/billboard-sprite.js";
import { createParticleBlend } from "./particle-blend.js";

const MULTIPLY_FRAGMENT_WGSL = `let sampled = textureSample(atlasTex, atlasSamp, in.uv);
let baseColor = sampled * in.tint * billboards.opacityMul;
let sourceAlpha = sampled.a * in.tint.a * billboards.opacityMul.a;
return vec4f(baseColor.rgb * sourceAlpha + vec3f(1.0) * (1.0 - sourceAlpha), baseColor.a);`;

/** @internal Build the optional particle Multiply or MultiplyAdd billboard renderable. */
export function buildParticleMultiplyBillboardRenderable(
    engine: EngineContext,
    system: FacingBillboardSpriteSystem,
    addPass: boolean
): { renderable: Renderable; dispose: () => void } {
    const addSystem = { ...system, blendMode: createParticleBlend(2) } as FacingBillboardSpriteSystem;
    _attachBillboardCustomShader(system, createBillboardCustomShader({ fragment: MULTIPLY_FRAGMENT_WGSL }));
    const built = buildBillboardRenderable(engine, system);
    if (!addPass) {
        return built;
    }

    const pipelineCache = createBillboardPipelineCache();
    const uniformBuffer = createEmptyUniformBuffer(engine, BILLBOARD_SYSTEM_UBO_BYTES, "particle-add-billboard-system-ubo");
    const bindGroups = new Map<GPURenderPipeline, GPUBindGroup>();
    const scratchUbo = new F32(BILLBOARD_SYSTEM_UBO_BYTES / 4);
    const lastUbo = new F32(BILLBOARD_SYSTEM_UBO_BYTES / 4);
    const bindMultiply = built.renderable.bind;
    let uboUploaded = false;
    let disposed = false;

    built.renderable.bind = (bindEngine, target) => {
        if (!target._depthStencilFormat) {
            throw new Error("BillboardSpriteSystem requires a depth-stencil render target.");
        }
        const primary = bindMultiply(bindEngine, target);
        const sampleCount = target._sampleCount === 1 ? 1 : 4;
        const addPipeline = getOrCreateBillboardPipeline(
            bindEngine,
            pipelineCache,
            target._colorFormat!,
            sampleCount,
            addSystem,
            target._depthStencilFormat,
            getSceneBindGroupLayout(bindEngine)
        );
        let addBindGroup = bindGroups.get(addPipeline);
        if (!addBindGroup) {
            addBindGroup = createBillboardSystemBindGroup(bindEngine, addPipeline, addSystem, uniformBuffer);
            bindGroups.set(addPipeline, addBindGroup);
        }
        return {
            renderable: built.renderable,
            pipeline: primary.pipeline,
            update(context) {
                primary.update?.(context);
                buildBillboardSystemUbo(system, scratchUbo);
                writeBillboardSystemUboIfDirty(bindEngine._device, uniformBuffer, scratchUbo, lastUbo, !uboUploaded);
                uboUploaded = true;
            },
            draw(pass, drawEngine) {
                const primaryDraws = primary.draw(pass, drawEngine);
                if (primaryDraws === 0) {
                    return 0;
                }
                pass.setPipeline(addPipeline);
                pass.setBindGroup(1, addBindGroup);
                pass.drawIndexed(6, system.count, 0, 0, 0);
                pass.setPipeline(primary.pipeline);
                return primaryDraws + 1;
            },
        };
    };

    return {
        renderable: built.renderable,
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            built.dispose();
            uniformBuffer.destroy();
            bindGroups.clear();
            resetBillboardPipelineCache(pipelineCache);
        },
    };
}
