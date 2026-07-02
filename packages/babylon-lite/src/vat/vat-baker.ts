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
import { mat4Invert } from "../math/mat4-invert.js";
import type { Mat4 } from "../math/types.js";
import { _registerPbrExt } from "../material/pbr/pbr-flags.js";
import { pbrExt as vatPbrExt } from "../material/pbr/fragments/vat-fragment.js";

/** Where one clip landed in the baked texture: its first row, its frame count, and its native fps. */
export interface VatClip {
    readonly fromRow: number;
    readonly frameCount: number;
    readonly fps: number;
}

/** Optional extras to capture while baking (nothing is captured unless requested). */
export interface VatBakeOptions {
    /** Bone indices whose posed ORIGIN should be sampled per baked frame (e.g. a hand joint for a held
     *  item, a muzzle, an FX socket). Bone index = position in the skeleton's joint list = the bone's row
     *  block in the baked texture. See {@link VatBakeResult.boneOrigins}. */
    readonly captureBoneOrigins?: readonly number[];
}

/** Result of baking — the GPU texture plus a per-clip row map for choosing playback params. */
export interface VatBakeResult {
    readonly texture: GPUTexture;
    readonly boneCount: number;
    readonly frameCount: number;
    /** Clip name → row range, for building the per-mesh/per-instance (fromRow,toRow,offset,fps) params. */
    readonly clips: Record<string, VatClip>;
    /** Present only when `captureBoneOrigins` was passed: bone index → the bone's posed origin per baked
     *  frame, as `frameCount * 3` xyz floats (frame `row` at offset `row*3`, matching the texture rows /
     *  `clips[].fromRow`). The point is in the mesh's SKIN output space — i.e. the space the VAT vertex path
     *  produces before the `world` uniform — so a consumer gets world space with `instance · mesh.world · p`.
     *  Lets a caller attach geometry to a moving joint (a carried prop, a socketed effect) without a live
     *  skeleton. */
    readonly boneOrigins?: Record<number, Float32Array>;
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
 * @param opts   - Optional extras to capture during the bake (e.g. per-frame bone origins).
 */
export function bakeVat(engine: EngineContext, mesh: Mesh, groups: AnimationGroup[], opts?: VatBakeOptions): VatBakeResult {
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

    // Optional per-frame bone-origin capture. Each bone matrix Lite bakes is `invMeshWorld · jointWorld · IBM`
    // (skeleton-pose.ts), so a bone's posed origin in skin-output space is `boneMatrix · restOrigin`, where
    // `restOrigin = translation(inverse(IBM))`. We capture rest origins lazily from the first binding, then
    // transform them each frame — the result lines up with the texture rows.
    const captureBones = opts?.captureBoneOrigins;
    const boneOrigins: Record<number, Float32Array> | undefined = captureBones ? {} : undefined;
    let restOrigins: Map<number, [number, number, number]> | null = null;
    if (captureBones && boneOrigins) {
        for (const b of captureBones) {
            boneOrigins[b] = new Float32Array(frameCount * 3);
        }
    }

    let row = 0;
    for (const g of groups) {
        const frames = clipFrameCount(g);
        const fps = g.frameRate || DEFAULT_FRAME_RATE;
        clips[g.name] = { fromRow: row, frameCount: frames, fps };
        const binding = bindingsOf(g)?.[0];
        if (captureBones && !restOrigins && binding) {
            restOrigins = computeRestOrigins(captureBones, binding.inverseBindMatrices, boneCount);
        }
        for (let f = 0; f < frames; f++) {
            goToFrame(g, f, engine); // evaluates the pose → binding.boneMatrices holds this frame's matrices
            const m = binding?.boneMatrices;
            if (m) {
                data.set(m.subarray(0, floatsPerFrame), row * floatsPerFrame);
                if (captureBones && boneOrigins && restOrigins) {
                    for (const b of captureBones) {
                        const o = restOrigins.get(b);
                        const dst = boneOrigins[b];
                        if (o && dst && b < boneCount) {
                            transformPointInto(dst, row * 3, m, b * 16, o[0], o[1], o[2]);
                        }
                    }
                }
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

    return boneOrigins ? { texture, boneCount, frameCount, clips, boneOrigins } : { texture, boneCount, frameCount, clips };
}

/** Rest origin of each requested bone = translation of `inverse(IBM_bone)` (its bind-pose world origin, in
 *  the skinned mesh's local space). Column-major, so translation is elements 12/13/14. */
function computeRestOrigins(bones: readonly number[], ibm: Float32Array, boneCount: number): Map<number, [number, number, number]> {
    const out = new Map<number, [number, number, number]>();
    for (const b of bones) {
        if (b < 0 || b >= boneCount) {
            continue;
        }
        const inv = mat4Invert(ibm.subarray(b * 16, b * 16 + 16) as unknown as Mat4);
        if (inv) {
            out.set(b, [inv[12]!, inv[13]!, inv[14]!]);
        }
    }
    return out;
}

/** Transform a point (px,py,pz,1) by the column-major mat4 stored in `m` at `mo`, writing xyz to `dst[di..]`. */
function transformPointInto(dst: Float32Array, di: number, m: Float32Array, mo: number, px: number, py: number, pz: number): void {
    dst[di] = m[mo]! * px + m[mo + 4]! * py + m[mo + 8]! * pz + m[mo + 12]!;
    dst[di + 1] = m[mo + 1]! * px + m[mo + 5]! * py + m[mo + 9]! * pz + m[mo + 13]!;
    dst[di + 2] = m[mo + 2]! * px + m[mo + 6]! * py + m[mo + 10]! * pz + m[mo + 14]!;
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
    /** Enable/refresh PER-INSTANCE VAT: upload one vec4 (fromRow, toRow, timeOffset, fps) per thin-instance,
     *  so every instance plays its own clip + phase from the one shared baked texture (all instances in a
     *  single draw call). `params.length` must be `4 * instanceCount`. Call this BEFORE registerScene the
     *  first time — it sets `mesh.vat.instanceTexture`; a VAT mesh that is thin-instanced then takes the
     *  per-instance vertex path. Later calls re-upload in place. Use `clips` to look up each clip's
     *  fromRow/toRow/fps when building `params`. (Internally expanded to the dual-clip layout, blend 0.) */
    setInstances(params: Float32Array): void;
    /** PER-INSTANCE DUAL-CLIP VAT: like setInstances, but each instance carries TWO clips that are blended,
     *  so gait cross-fades stay smooth. `params.length` must be `8 * instanceCount` — two vec4s per instance:
     *  A = (fromRowA, toRowA, timeOffset, fpsA), B = (fromRowB, toRowB, blendWeight, fpsB), where blendWeight
     *  in [0,1] lerps A→B and B reuses A's timeOffset. Same per-instance VAT path as setInstances. */
    setInstancesBlend(params: Float32Array): void;
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
    let instanceTex: GPUTexture | null = null;
    let instanceTexCap = 0; // capacity in TEXELS (always 2 per instance — the dual-clip layout)
    const writeUbo = (): void => {
        device.queue.writeBuffer(settingsBuffer, 0, ubo.buffer, ubo.byteOffset, 32);
    };
    // Upload per-instance VAT params (TWO texels per instance — clip A then clip B) into a (texels x 1)
    // rgba32float texture the VAT vertex path reads by instance_index.
    const uploadInstances = (params: Float32Array): void => {
        const texels = Math.max(2, params.length >> 2); // 4 floats per texel
        if (!instanceTex || texels > instanceTexCap) {
            instanceTex?.destroy();
            instanceTex = device.createTexture({
                size: [texels, 1],
                format: "rgba32float",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            instanceTexCap = texels;
            vat.instanceTexture = instanceTex;
        }
        device.queue.writeTexture({ texture: instanceTex }, params.buffer, { offset: params.byteOffset, bytesPerRow: texels * 16, rowsPerImage: 1 }, { width: texels, height: 1 });
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
        setInstances(params) {
            // Single clip per instance (4 floats: fromRow,toRow,offset,fps) expanded to the dual-clip
            // layout (clip B == A, blend 0) so the one instanced shader variant renders it.
            const n = params.length >> 2;
            const dual = new Float32Array(n * 8);
            for (let i = 0; i < n; i++) {
                const s = i * 4;
                const o = i * 8;
                dual[o] = params[s]!;
                dual[o + 1] = params[s + 1]!;
                dual[o + 2] = params[s + 2]!;
                dual[o + 3] = params[s + 3]!;
                dual[o + 4] = params[s]!;
                dual[o + 5] = params[s + 1]!;
                dual[o + 6] = 0;
                dual[o + 7] = params[s + 3]!;
            }
            uploadInstances(dual);
        },
        setInstancesBlend(params) {
            uploadInstances(params);
        },
    };
    handle.play(clip ?? Object.keys(baked.clips)[0] ?? "");
    return handle;
}
