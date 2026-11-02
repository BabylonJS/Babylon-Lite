import type { EngineContext } from "../../packages/babylon-lite/src/engine/engine.js";
import { createRenderTarget, disposeRenderTarget } from "../../packages/babylon-lite/src/engine/render-target.js";
import type { RenderTarget } from "../../packages/babylon-lite/src/engine/render-target.js";
import type { Task } from "../../packages/babylon-lite/src/frame-graph/task.js";
import { ssaoHalfWGSL } from "../../packages/babylon-lite/src/post-process/ssao-wgsl.js";

/** Match the exact signed RGBA16 normal bytes uploaded by the native HLSL adapter. */
export function createDiligentNormalInput(engine: EngineContext, source: RenderTarget, width: number, height: number): Task & { readonly outputTexture: RenderTarget } {
    const device = engine._device;
    const target = createRenderTarget({ lbl: "diligent-signed-normal", format: "rgba16float", samples: 1, size: { width, height } });
    const texture = device.createTexture({
        label: "diligent-signed-normal",
        size: [width, height],
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    target._colorTexture = texture;
    target._colorView = texture.createView();
    target._width = width;
    target._height = height;
    target._eager = true;
    const layout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
        ],
    });
    const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: {
            entryPoint: "main",
            module: device.createShaderModule({
                code: `${ssaoHalfWGSL()}
@group(0) @binding(0) var encoded:texture_2d<f32>;
@group(0) @binding(1) var decoded:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=textureDimensions(decoded))){return;}
let p=vec2i(id.xy);let input=textureLoad(encoded,p,0);let n=input.xyz*2.0-1.0;
let rounded=sign(n)*vec3f(aoHalf(abs(n.x)),aoHalf(abs(n.y)),aoHalf(abs(n.z)));
textureStore(decoded,p,vec4f(rounded,input.w));
}`,
            }),
        },
    });
    let group: GPUBindGroup | null = null;
    return {
        name: "diligent-normal-contract",
        engine,
        _passes: [],
        outputTexture: target,
        record() {
            if (!source._colorView) {
                throw new Error("Diligent normal source must be recorded before decoding.");
            }
            group = device.createBindGroup({
                layout,
                entries: [
                    { binding: 0, resource: source._colorView },
                    { binding: 1, resource: target._colorView! },
                ],
            });
        },
        execute() {
            const pass = engine._currentEncoder.beginComputePass({ label: "diligent-normal-contract" });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group!);
            pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            pass.end();
            return 0;
        },
        dispose() {
            disposeRenderTarget(target);
        },
    };
}
