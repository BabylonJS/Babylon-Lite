import { BU, TU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawBinding, DrawUpdateContext, Renderable } from "../render/renderable.js";
import type { SceneContext } from "../scene/scene-core.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { _packSceneUniforms } from "../frame-graph/scene-uniforms-pack.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-size.js";
import { ensureSceneLightState } from "../render/scene-lights-ubo.js";
import type { RenderTask } from "../frame-graph/render-task-base.js";

export function gpsOpaqueSources(scene: SceneContext, signature: RenderTargetSignature): readonly Renderable[] {
    const task = scene._frameGraph?._tasks.find((item): item is RenderTask => "_targetSignature" in item && item._targetSignature === signature);
    return task?._renderables ?? scene._renderables;
}

/** Opaque visibility is evaluated before point samples enter their running mean. */
export interface GpsSceneDepth {
    texture: GPUTexture;
    view: GPUTextureView;
    color: GPUTexture | null;
    version: number;
    bindings: DrawBinding[];
    active: boolean;
    uniforms: GPUBuffer;
    source: readonly Renderable[] | null;
}

export function gpsCreateSceneDepth(device: GPUDevice): GpsSceneDepth {
    const texture = device.createTexture({ label: "GPS empty scene depth", size: [1, 1], format: "depth32float", usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    const uniforms = device.createBuffer({ size: SCENE_UBO_BYTES, usage: BU.UNIFORM | BU.COPY_DST });
    return { texture, view: texture.createView(), color: null, version: -1, bindings: [], active: false, uniforms, source: null };
}

export function gpsRecordSceneDepth(
    state: GpsSceneDepth,
    scene: SceneContext,
    engine: EngineContext,
    signature: RenderTargetSignature,
    context: DrawUpdateContext,
    retire: (textures: GPUTexture[]) => void
): boolean {
    const device = engine._device;
    const source = gpsOpaqueSources(scene, signature);
    if (state.version !== scene._renderableVersion || state.source !== source) {
        state.bindings = source
            .filter((renderable) => !renderable.isTransparent && !!renderable.mesh)
            .map((renderable) =>
                renderable.bind(engine, { ...signature, _sampleCount: 1, _depthStencilFormat: "depth32float", _depthCompare: signature._depthCompare ?? "greater-equal" })
            );
        state.version = scene._renderableVersion;
        state.source = source;
    }
    state.active = state.bindings.some((binding) => binding.renderable.mesh?.visible !== false);
    const width = state.active ? Math.floor(context.targetWidth * (context._camera?.viewport?.width ?? 1)) : 1;
    const height = state.active ? Math.floor(context.targetHeight * (context._camera?.viewport?.height ?? 1)) : 1;
    if (state.texture.width !== width || state.texture.height !== height || (!!signature._colorFormat && state.active !== !!state.color)) {
        retire([state.texture, ...(state.color ? [state.color] : [])]);
        state.texture = device.createTexture({ label: "GPS scene depth", size: [width, height], format: "depth32float", usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
        state.view = state.texture.createView();
        state.color =
            state.active && signature._colorFormat
                ? device.createTexture({ label: "GPS opaque color", size: [width, height], format: signature._colorFormat, usage: TU.RENDER_ATTACHMENT })
                : null;
    }
    if (!state.active) {
        return false;
    }
    const camera = context._camera!;
    const data = new Float32Array(SCENE_UBO_BYTES / 4);
    const viewport = camera.viewport;
    const aspect = (context.targetWidth / context.targetHeight) * (viewport ? viewport.width / viewport.height : 1);
    _packSceneUniforms(data, engine, scene, camera, aspect);
    scene._sceneUboContributors?.forEach((contributor) => contributor(data, scene));
    device.queue.writeBuffer(state.uniforms, 0, data);
    const sceneGroup = device.createBindGroup({
        layout: getSceneBindGroupLayout(engine),
        entries: [
            { binding: 0, resource: { buffer: state.uniforms } },
            { binding: 1, resource: { buffer: ensureSceneLightState(engine, scene)._buffer } },
        ],
    });
    const batches = new Set(state.bindings.flatMap((binding) => binding._updateBatches ?? []));
    batches.forEach((batch) => batch.reset());
    state.bindings.forEach((binding) => binding.update?.(context));
    batches.forEach((batch) => batch.flush(engine));
    const pass = engine._currentEncoder.beginRenderPass({
        label: "GPS opaque visibility",
        colorAttachments: state.color ? [{ view: state.color.createView(), loadOp: "clear", storeOp: "discard", clearValue: [0, 0, 0, 0] }] : [],
        depthStencilAttachment: { view: state.view, depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: signature._depthCompare?.startsWith("less") ? 1 : 0 },
    });
    pass.setBindGroup(0, sceneGroup);
    for (const binding of state.bindings) {
        if (binding.renderable.mesh?.visible === false) {
            continue;
        }
        pass.setPipeline(binding.pipeline);
        binding.draw(pass, engine);
    }
    pass.end();
    return true;
}
