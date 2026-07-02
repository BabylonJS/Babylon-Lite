/**
 * Depth pyramid — a hierarchical ("Hi-Z") mip chain of a depth buffer where each coarser level combines its
 * four child texels with `min()` or `max()`. The classic uses are GPU occlusion culling (test a screen-space
 * bounding box against the coarse level that covers it) and hierarchical screen-space ray marching (skip empty
 * space at coarse mips, refine to a precise hit at level 0), plus horizon-search AO and contact shadows.
 *
 * WebGPU has no built-in min/max mip reduction, so — like `generate-mipmaps` — we render a fullscreen triangle
 * per level. Two pipelines:
 *   • COPY:   sample the source `texture_depth_2d` → write its NDC depth into mip 0 of an `r32float` texture.
 *   • REDUCE: each coarser level = `min`/`max` of its four child texels of the previous level.
 *
 * The `reduce` mode is the caller's choice of depth convention + use: a reverse-Z Hi-Z (near = 1) wants `max`
 * (keeps the NEAREST surface per tile — what a skip-empty ray march needs); a farthest-occluder pyramid for
 * occlusion culling wants `min` in reverse-Z (the deepest occluder is the conservative bound). Nearest sampler,
 * so the consumer reads it with `textureLoad(tex, coord, mip)`.
 *
 * The output `Texture2D` ref-counts through the shared texture pool: the pyramid holds one base ref so a
 * consumer material's bind/rebind churn can never drive it to zero. `resize()` mints a FRESH wrapper (new
 * identity) so the consumer's `setShaderTexture` sees the change and rebuilds its bind group against the new
 * view; the old texture stays alive until the consumer releases its own ref (no destroy-while-referenced).
 */

import { TU, SS } from "../engine/gpu-flags.js";
import { acquireTexture, releaseTexture, getOrCreateSampler } from "../resource/gpu-pool.js";
import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { Task } from "./task.js";

/** Full mip chain length for a width/height (log2 of the larger side + 1). */
function mipLevelCount(width: number, height: number): number {
    return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

const COPY_SHADER = `@group(0)@binding(0)var src:texture_depth_2d;
struct V{@builtin(position)p:vec4f};
@vertex fn vs(@builtin(vertex_index)i:u32)->V{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];return V(vec4f(p,0,1));}
@fragment fn fs(@builtin(position)fc:vec4f)->@location(0)f32{return textureLoad(src,vec2<i32>(fc.xy),0);}`;

/** REDUCE fragment: `op` is `min` or `max` of the four child texels of the previous level. */
function reduceShader(op: "min" | "max"): string {
    return `@group(0)@binding(0)var src:texture_2d<f32>;
struct V{@builtin(position)p:vec4f};
@vertex fn vs(@builtin(vertex_index)i:u32)->V{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];return V(vec4f(p,0,1));}
@fragment fn fs(@builtin(position)fc:vec4f)->@location(0)f32{
  let c=vec2<i32>(fc.xy)*2;
  let d=vec2<i32>(textureDimensions(src))-vec2<i32>(1,1);
  let x1=min(c.x+1,d.x); let y1=min(c.y+1,d.y);
  let a=textureLoad(src,vec2<i32>(c.x,c.y),0).r;
  let b=textureLoad(src,vec2<i32>(x1,c.y),0).r;
  let e=textureLoad(src,vec2<i32>(c.x,y1),0).r;
  let f=textureLoad(src,vec2<i32>(x1,y1),0).r;
  return ${op}(${op}(a,b),${op}(e,f));
}`;
}

/** How each coarser pyramid level combines its four child texels. */
export type DepthPyramidReduce = "min" | "max";

export interface DepthPyramidOptions {
    /** Mip-0 width — match the source depth texture. */
    width: number;
    /** Mip-0 height — match the source depth texture. */
    height: number;
    /** Child-texel combine: `max` (default; reverse-Z nearest-surface Hi-Z) or `min` (forward-Z, or
     *  reverse-Z farthest-occluder for occlusion culling). */
    reduce?: DepthPyramidReduce;
}

/** A rebuildable hierarchical depth pyramid. Create with `createDepthPyramid`; drive its per-frame build with
 *  `createDepthPyramidTask` (in-frame) or by calling `build()` yourself. */
export interface DepthPyramid {
    /** `r32float`, full mip chain, nearest sampler. Bind to a material; read `textureLoad(tex, coord, mip)`.
     *  A `resize()` replaces this wrapper (new identity) — re-read it and re-bind after a resize. */
    readonly texture: Texture2D;
    /** Number of mip levels in the current pyramid. */
    readonly mipCount: number;
    /** Re-derive the pyramid from `depthTexture` (a `texture_depth_2d` of matching mip-0 size). Pass the frame
     *  `encoder` to record the COPY/REDUCE passes in-frame (e.g. after a depth prepass, before the consumer that
     *  samples the pyramid); omit it to run on a private encoder + submit immediately. */
    build(depthTexture: Texture2D, encoder?: GPUCommandEncoder): void;
    /** Reallocate the pyramid texture at a new mip-0 size (call when the source depth target resizes). No-op if
     *  unchanged. Mint a new `texture` wrapper on a real change; safe to call any time (does not destroy the old
     *  texture while a consumer still references it). */
    resize(width: number, height: number): void;
    /** Release the pyramid's base texture ref (frees the GPU texture once no consumer holds it). */
    dispose(): void;
}

interface EngineDevice {
    _device: GPUDevice;
}

/** Create a hierarchical depth pyramid sized `width`×`height`. Build it each frame from the live depth texture
 *  (via `createDepthPyramidTask`, or `build()` directly). Owns its COPY/REDUCE pipelines + the mipped texture. */
export function createDepthPyramid(engine: EngineContext, opts: DepthPyramidOptions): DepthPyramid {
    const device = (engine as unknown as EngineDevice)._device;
    const reduce = opts.reduce ?? "max";
    const sampler = getOrCreateSampler(engine, { minFilter: "nearest", magFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });

    const copyBGL = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } }],
    });
    const reduceBGL = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } }],
    });
    const mk = (code: string, layout: GPUBindGroupLayout): GPURenderPipeline =>
        device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
            vertex: { module: device.createShaderModule({ code }), entryPoint: "vs" },
            fragment: { module: device.createShaderModule({ code }), entryPoint: "fs", targets: [{ format: "r32float" }] },
            primitive: { topology: "triangle-list" },
        });
    const copyPipeline = mk(COPY_SHADER, copyBGL);
    const reducePipeline = mk(reduceShader(reduce), reduceBGL);

    let w = Math.max(1, opts.width | 0);
    let h = Math.max(1, opts.height | 0);
    let mips = mipLevelCount(w, h);

    function makeTexture(): GPUTexture {
        return device.createTexture({
            label: "depth-pyramid",
            size: { width: w, height: h },
            format: "r32float",
            usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING,
            mipLevelCount: mips,
        });
    }
    function makeWrapper(tex: GPUTexture): Texture2D {
        // One base ref so a consuming material's per-version release/acquire churn never drives the pool count to
        // 0 and destroys the texture out from under us. `_sampleType: "float"` — r32float sampled as unfilterable float.
        const wr = { texture: tex, view: tex.createView(), sampler, width: w, height: h, _sampleType: "float" } as Texture2D;
        acquireTexture(wr);
        return wr;
    }

    let gpuTex = makeTexture();
    let wrapper = makeWrapper(gpuTex);

    // Per-frame GPU objects cached across build() calls and rebuilt only on resize(): the mip-0 COPY target view and,
    // for each coarser level, a { dst view, REDUCE bind group } pair (the reduce bind group reads the previous level
    // of our own texture, so it only changes when the texture is reallocated). The COPY bind group reads the EXTERNAL
    // source depth, so it is rebuilt lazily only when that source Texture2D changes identity (e.g. a canvas-resize
    // reallocation). This keeps build() free of per-frame view/bind-group churn.
    let copyDstView: GPUTextureView;
    let reduceLevels: { dst: GPUTextureView; bindGroup: GPUBindGroup }[] = [];
    let copyBindGroup: GPUBindGroup | null = null;
    let copyBindGroupSource: Texture2D | null = null;

    function rebuildViews(): void {
        copyDstView = gpuTex.createView({ baseMipLevel: 0, mipLevelCount: 1 });
        reduceLevels = [];
        for (let mip = 1; mip < mips; mip++) {
            const src = gpuTex.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 });
            const dst = gpuTex.createView({ baseMipLevel: mip, mipLevelCount: 1 });
            reduceLevels.push({ dst, bindGroup: device.createBindGroup({ layout: reduceBGL, entries: [{ binding: 0, resource: src }] }) });
        }
        // The texture identity changed, so the source-keyed COPY bind group is stale — force a rebuild next build().
        copyBindGroup = null;
        copyBindGroupSource = null;
    }
    rebuildViews();

    return {
        get texture(): Texture2D {
            return wrapper;
        },
        get mipCount(): number {
            return mips;
        },
        build(depthTexture: Texture2D, encoder?: GPUCommandEncoder): void {
            const enc = encoder ?? device.createCommandEncoder();
            // COPY bind group reads the external source depth; rebuild only when that source changes identity.
            if (copyBindGroup === null || copyBindGroupSource !== depthTexture) {
                copyBindGroup = device.createBindGroup({ layout: copyBGL, entries: [{ binding: 0, resource: depthTexture.view }] });
                copyBindGroupSource = depthTexture;
            }
            // mip 0 ← source depth.
            const copyPass = enc.beginRenderPass({
                label: "depth-pyramid-copy",
                colorAttachments: [{ view: copyDstView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
            });
            copyPass.setPipeline(copyPipeline);
            copyPass.setBindGroup(0, copyBindGroup);
            copyPass.draw(3);
            copyPass.end();
            // mips 1..N ← min/max reduction of the previous level.
            for (const level of reduceLevels) {
                const pass = enc.beginRenderPass({
                    label: "depth-pyramid-reduce",
                    colorAttachments: [{ view: level.dst, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
                });
                pass.setPipeline(reducePipeline);
                pass.setBindGroup(0, level.bindGroup);
                pass.draw(3);
                pass.end();
            }
            // Submit only when we own the encoder. With an external (frame) encoder the frame graph submits it,
            // and WebGPU auto-inserts the depth→sampled barrier between the source-producing pass and our COPY.
            if (!encoder) {
                device.queue.submit([enc.finish()]);
            }
        },
        resize(nw: number, nh: number): void {
            const cw = Math.max(1, nw | 0);
            const ch = Math.max(1, nh | 0);
            if (cw === w && ch === h) {
                return;
            }
            w = cw;
            h = ch;
            mips = mipLevelCount(w, h);
            const old = wrapper;
            gpuTex = makeTexture();
            wrapper = makeWrapper(gpuTex); // fresh identity → consumer's setShaderTexture rebuilds against the new view
            rebuildViews(); // cached views/bind groups point at the old texture — rebuild them against the new one
            releaseTexture(old); // drop OUR base ref; the old texture frees once the consumer releases its ref too
        },
        dispose(): void {
            releaseTexture(wrapper);
        },
    };
}

/** Options for `createDepthPyramidTask`. */
export interface DepthPyramidTaskOptions {
    /** The pyramid to build each frame. The task ADOPTS it — the frame graph disposes it on graph dispose, so do
     *  not also dispose it yourself. */
    pyramid: DepthPyramid;
    /** The live source depth texture for this frame (e.g. a depth-prepass target). Return `null` to skip the
     *  build this frame (e.g. before the source exists, or when nothing consumes the pyramid). */
    source: () => Texture2D | null;
}

/** Create a frame-graph task that rebuilds `pyramid` from `source()` into the FRAME command encoder each frame.
 *  Order it right after the pass that produces the depth (e.g. `addTaskAfter(scene, task, depthPrepassTask)`) so
 *  the pyramid reflects THIS frame's depth. Resize the pyramid to the source's size before the frame is recorded
 *  (the source depth target only changes size on a canvas resize). */
export function createDepthPyramidTask(engine: EngineContext, scene: SceneContext, opts: DepthPyramidTaskOptions): Task {
    const { pyramid, source } = opts;
    return {
        name: "depth-pyramid",
        engine,
        scene,
        _passes: [],
        record(): void {
            /* No recorded Pass objects — the COPY/REDUCE passes are recorded straight into the frame encoder in execute(). */
        },
        execute(): number {
            const src = source();
            if (!src) {
                return 0;
            }
            pyramid.build(src, engine._currentEncoder);
            return pyramid.mipCount;
        },
        dispose(): void {
            pyramid.dispose();
        },
    };
}
