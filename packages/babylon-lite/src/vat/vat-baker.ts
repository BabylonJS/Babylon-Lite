/**
 * VAT (Vertex Animation Texture) baker + runtime manager.
 *
 * Pre-evaluates a skinned mesh's skeletal animation on the CPU and stacks every frame's bone matrices
 * into ONE rgba32float texture (the per-row layout is identical to the live bone texture in
 * skeleton/create-skeleton.ts — 4 texels per bone — just `frameCount` rows tall). The mesh then renders
 * through the VAT vertex path (material/pbr/fragments/vat-fragment.ts), which reads bone matrices from the
 * baked texture at the current frame row instead of a live per-frame upload. With the CPU skeleton gone
 * the mesh can be GPU thin-instanced — each instance playing its own clip/frame.
 *
 * Mirrors the BJS VertexAnimationBaker / BakedVertexAnimationManager API shape, adapted to Lite/WebGPU.
 *
 * This module has ZERO module-level side effects and is only reached when a scene bakes a VAT, so it (and
 * the VAT shader fragment) cost nothing for scenes that don't use vertex animation.
 */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { AnimationGroup } from "../animation/animation-group.js";
import { goToFrame, stopAnimation } from "../animation/animation-group.js";
import type { SkeletonBinding, VatData } from "../animation/types.js";
import { _registerPbrExt } from "../material/pbr/pbr-flags.js";
import { pbrExt as vatPbrExt } from "../material/pbr/fragments/vat-fragment.js";

/** Where one clip landed in the baked texture: its first row, its frame count, and its native fps. */
export interface VatClip {
    readonly fromRow: number;
    readonly frameCount: number;
    readonly fps: number;
}

/** Result of baking — the GPU texture plus a per-clip row map for choosing playback params. */
export interface VatBakeResult {
    readonly texture: GPUTexture;
    readonly boneCount: number;
    readonly frameCount: number;
    /** Clip name → row range, for building the per-mesh/per-instance (fromRow,toRow,offset,fps) params. */
    readonly clips: Record<string, VatClip>;
}

const DEFAULT_FRAME_RATE = 60;

/** Number of baked frames for a clip (inclusive of frame 0). */
function clipFrameCount(group: AnimationGroup): number {
    const fps = group.frameRate || DEFAULT_FRAME_RATE;
    return Math.max(1, Math.round(group.duration * fps) + 1);
}

function bindingsOf(group: AnimationGroup): readonly SkeletonBinding[] | undefined {
    return group._gltfMixer?.[2];
}

/**
 * Bake the given animation clips of a skinned mesh into a VAT texture. The clips are laid out as
 * contiguous row blocks (clip 0 first), one texture row per frame. The mesh must still have its live
 * `skeleton` at bake time (the bone matrices are read from it as each frame is evaluated).
 *
 * @param engine - Engine context.
 * @param mesh   - The skinned source mesh (must have `mesh.skeleton`).
 * @param groups - The animation clips to bake (e.g. a creature's gait clips).
 */
export function bakeVat(engine: EngineContext, mesh: Mesh, groups: AnimationGroup[]): VatBakeResult {
    const skel = mesh.skeleton;
    if (!skel) {
        throw new Error("bakeVat: mesh has no skeleton to bake.");
    }
    const boneCount = skel.boneCount;
    const texWidth = boneCount * 4; // 4 texels per bone (one mat4 column each), same as the live bone texture
    const floatsPerFrame = boneCount * 16;

    let frameCount = 0;
    for (const g of groups) {
        frameCount += clipFrameCount(g);
    }
    frameCount = Math.max(1, frameCount);

    const data = new Float32Array(frameCount * floatsPerFrame);
    const clips: Record<string, VatClip> = {};

    let row = 0;
    for (const g of groups) {
        const frames = clipFrameCount(g);
        const fps = g.frameRate || DEFAULT_FRAME_RATE;
        clips[g.name] = { fromRow: row, frameCount: frames, fps };
        const binding = bindingsOf(g)?.[0];
        for (let f = 0; f < frames; f++) {
            goToFrame(g, f, engine); // evaluates the pose → binding.boneMatrices holds this frame's matrices
            const m = binding?.boneMatrices;
            if (m) {
                data.set(m.subarray(0, floatsPerFrame), row * floatsPerFrame);
            }
            row++;
        }
        stopAnimation(g); // we never want this clip ticking live again — VAT replaces it
    }

    const device = engine._device;
    const texture = device.createTexture({
        size: [texWidth, frameCount],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, data.buffer, { bytesPerRow: texWidth * 16, rowsPerImage: frameCount }, { width: texWidth, height: frameCount });

    return { texture, boneCount, frameCount, clips };
}

/** Runtime VAT playback handle for one mesh (the analogue of BJS BakedVertexAnimationManager + the
 *  per-mesh settings). Advance `update()` each frame; set the active clip with `play()`. */
export interface VatHandle {
    /** The mesh this drives (its `mesh.vat` is set). */
    readonly mesh: Mesh;
    /** Baked clip row map. */
    readonly clips: Record<string, VatClip>;
    /** Select the clip to play (by name) or set explicit playback params. */
    play(clip: string, opts?: { offset?: number; fps?: number }): void;
    /** Advance the animation clock by `dtSeconds` and upload it. */
    update(dtSeconds: number): void;
}

/**
 * Attach a baked VAT to a mesh: builds the settings UBO, sets `mesh.vat` (reusing the skeleton's
 * joints/weights vertex buffers), and DROPS the live skeleton so it's no longer CPU-updated. Returns a
 * handle that advances the animation clock.
 *
 * @param engine - Engine context.
 * @param mesh   - The mesh that was baked (still has `mesh.skeleton`).
 * @param baked  - The result of `bakeVat`.
 * @param clip   - Initial clip name to play (defaults to the first baked clip).
 */
export function attachVat(engine: EngineContext, mesh: Mesh, baked: VatBakeResult, clip?: string): VatHandle {
    const skel = mesh.skeleton;
    if (!skel) {
        throw new Error("attachVat: mesh has no skeleton (bake first, attach before clearing it).");
    }
    // Self-register the VAT PBR extension into the global registry (mirrors enableMaterialPlugins): this
    // is what keeps non-VAT scenes byte-identical — the shared PBR renderable carries NO VAT-specific
    // code (no dynamic-import tuple), it just walks the generic ext registry, which this populates only
    // when a scene actually bakes + attaches a VAT. Idempotent (keyed by ext id).
    _registerPbrExt(vatPbrExt);
    const device = engine._device;
    // UBO: params vec4 (fromRow, toRow, frameOffset, fps) + clock vec4 (.x = seconds). 32 bytes.
    const settingsBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const ubo = new Float32Array(8);

    const vat: VatData = {
        boneCount: baked.boneCount,
        texture: baked.texture,
        frameCount: baked.frameCount,
        settingsBuffer,
        jointsBuffer: skel.jointsBuffer,
        weightsBuffer: skel.weightsBuffer,
        joints1Buffer: skel.joints1Buffer,
        weights1Buffer: skel.weights1Buffer,
    };
    mesh.vat = vat;
    mesh.skeleton = null; // baked: no live skinning, no skeleton fragment, no per-frame bone upload

    let time = 0;
    const writeUbo = (): void => {
        device.queue.writeBuffer(settingsBuffer, 0, ubo.buffer, ubo.byteOffset, 32);
    };
    const handle: VatHandle = {
        mesh,
        clips: baked.clips,
        play(name, opts) {
            const c = baked.clips[name];
            if (!c) {
                return;
            }
            ubo[0] = c.fromRow;
            ubo[1] = c.fromRow + c.frameCount - 1;
            ubo[2] = opts?.offset ?? 0;
            ubo[3] = opts?.fps ?? c.fps;
            writeUbo();
        },
        update(dt) {
            time += dt;
            ubo[4] = time;
            writeUbo();
        },
    };
    handle.play(clip ?? Object.keys(baked.clips)[0] ?? "");
    return handle;
}
