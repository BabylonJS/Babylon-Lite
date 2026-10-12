import { CW, SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import { targetSignatureKey } from "../engine/render-target-signature.js";
import { getEffectiveAspectRatio, getProjectionMatrix, getViewMatrix } from "../camera/camera.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import type { DrawBinding, DrawUpdateContext, Renderable } from "../render/renderable.js";
import { getSplatStreamDrawBatch, splatStreamProjectionKey, type SplatStreamDrawBatch, type SplatStreamGpuState, type SplatStreamPassGpu } from "./splat-stream-gpu.js";
import RENDER_WGSL from "./splat-stream-render.wgsl?raw";

interface RenderPipelineEntry {
    readonly pipeline: GPURenderPipeline;
    readonly layout: GPUBindGroupLayout;
}

let _renderCache: { device: GPUDevice; module: GPUShaderModule; entries: Map<string, RenderPipelineEntry> } | null = null;

function getPipeline(engine: EngineContext, signature: RenderTargetSignature): RenderPipelineEntry {
    const device = engine._device;
    if (!_renderCache || _renderCache.device !== device) {
        _renderCache = { device, module: device.createShaderModule({ label: "splat stream render", code: RENDER_WGSL }), entries: new Map() };
    }
    const key = targetSignatureKey(signature);
    const cached = _renderCache.entries.get(key);
    if (cached) {
        return cached;
    }
    const layout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: SS.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 1, visibility: SS.VERTEX, buffer: { type: "read-only-storage" } },
        ],
    });
    const depthStencil = signature._depthStencilFormat
        ? {
              format: signature._depthStencilFormat,
              depthCompare: signature._depthCompare ?? ("greater-equal" as GPUCompareFunction),
              depthWriteEnabled: false,
          }
        : undefined;
    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [getSceneBindGroupLayout(engine), layout] }),
        vertex: { module: _renderCache.module, entryPoint: "vs" },
        fragment: {
            module: _renderCache.module,
            entryPoint: "fs",
            targets: [
                {
                    format: signature._colorFormat!,
                    blend: {
                        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                    },
                    writeMask: CW.ALL,
                },
            ],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil,
        multisample: { count: signature._sampleCount },
    });
    const entry = { pipeline, layout };
    _renderCache.entries.set(key, entry);
    return entry;
}

function multiply(out: Float32Array, left: ArrayLike<number>, right: ArrayLike<number>): void {
    for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
            out[column * 4 + row] =
                left[row]! * right[column * 4]! + left[4 + row]! * right[column * 4 + 1]! + left[8 + row]! * right[column * 4 + 2]! + left[12 + row]! * right[column * 4 + 3]!;
        }
    }
}

function getRenderBindGroup(engine: EngineContext, entry: RenderPipelineEntry, passGpu: SplatStreamPassGpu): GPUBindGroup {
    if (!passGpu.bindGroup) {
        passGpu.bindGroup = engine._device.createBindGroup({
            layout: entry.layout,
            entries: [
                { binding: 0, resource: { buffer: passGpu.projected } },
                { binding: 1, resource: { buffer: passGpu.sorted } },
            ],
        });
    }
    return passGpu.bindGroup;
}

/** @internal Gives each material/view binding one stable selection identity. */
export function createSplatStreamSelectionUpdate(onUpdate?: (context: DrawUpdateContext, binding: object) => void): (context: DrawUpdateContext) => void {
    const selectionBinding = {};
    return (context) => onUpdate?.(context, selectionBinding);
}

/** @internal Builds the GPU streaming draw only; public loader/attach orchestration intentionally lives elsewhere. */
export function buildSplatStreamGpuRenderable(
    state: SplatStreamGpuState,
    worldMatrix: () => ArrayLike<number>,
    onUpdate?: (context: DrawUpdateContext, binding: object) => void,
    onDraw?: (nonemptySignal: Promise<boolean> | null) => void
): Renderable {
    const renderable: Renderable = {
        order: 200,
        isTransparent: true,
        bind(engine: EngineContext, signature: RenderTargetSignature): DrawBinding {
            const entry = getPipeline(engine, signature);
            const batch: SplatStreamDrawBatch = getSplatStreamDrawBatch(state, signature);
            const updateSelection = createSplatStreamSelectionUpdate(onUpdate);
            const worldView = new Float32Array(16);
            let drawable = false;
            const update = (context: DrawUpdateContext): void => {
                updateSelection(context);
                const camera = context._camera;
                drawable = !!camera && !camera.ortho && context.targetWidth > 0 && context.targetHeight > 0;
                if (!drawable || !camera) {
                    return;
                }
                const viewport = camera.viewport;
                const width = context.targetWidth * (viewport?.width ?? 1);
                const height = context.targetHeight * (viewport?.height ?? 1);
                const view = getViewMatrix(camera);
                const projection = getProjectionMatrix(camera, getEffectiveAspectRatio(camera, context.targetWidth, context.targetHeight));
                multiply(worldView, view, worldMatrix());
                const viewportKey = viewport ? `/${viewport.x}/${viewport.y}/${viewport.width}/${viewport.height}` : "";
                batch.queue({
                    count: state.count,
                    key: splatStreamProjectionKey(state.contentGeneration, width, height, worldView, projection) + viewportKey,
                    worldView: worldView.slice(),
                    projection: Float32Array.from(projection),
                    width,
                    height,
                    near: camera.nearPlane,
                });
            };
            return {
                renderable,
                pipeline: entry.pipeline,
                update,
                _updateBatches: [batch],
                draw(pass) {
                    if (!drawable) {
                        return 0;
                    }
                    pass.setBindGroup(1, getRenderBindGroup(engine, entry, batch.passGpu));
                    pass.drawIndirect(batch.passGpu.indirect, 0);
                    const bootstrapSignal = batch.takeBootstrapSignal();
                    if (bootstrapSignal) {
                        onDraw?.(bootstrapSignal);
                    }
                    return 1;
                },
            };
        },
    };
    return renderable;
}
