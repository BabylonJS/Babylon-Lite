/**
 * Per-system GPU pick contributor for billboard sprites.
 *
 * Registered idempotently by the billboard renderable when the system is
 * added to the scene. Owns:
 *   - per-system 80 B pick UBO (camera basis + lock axis + base ID + alphaCutoff)
 *   - lazy bind group rebuild on storage buffer reallocation
 *   - resolve(pickId) -> SpritePickInfo
 *
 * Picking and rendering share the same packed sprite storage so the picked
 * silhouette matches the rendered silhouette frame-by-frame, including
 * alpha-cutout discard.
 */

import type { SceneContext, SceneContextInternal } from "../../scene/scene.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { PickContributor, PickPassContext } from "../../picking/picking-contributors.js";
import { getOrCreatePickContributors } from "../../picking/picking-contributors.js";
import { createEmptyPickingInfo, type PickingInfo } from "../../picking/picking-info.js";
import type { BillboardSpriteSystem } from "../sprite-billboard-shared.js";
import { SPRITE_BILLBOARD_STRIDE } from "../sprite-billboard-shared.js";
import { BILLBOARD_PICK_UBO_BYTES, getBillboardPickPipeline } from "./billboard-pick-pipeline.js";

export interface SpritePickInfo {
    layerOrSystem: BillboardSpriteSystem;
    spriteIndex: number;
    uv: [number, number];
    screenPx: [number, number];
    worldPosition?: [number, number, number];
}

interface BillboardContributor extends PickContributor {
    rangeStart: number;
    rangeEnd: number;
}

let _lastPickX = 0;
let _lastPickY = 0;
export function _setLastPickCoords(x: number, y: number): void {
    _lastPickX = x;
    _lastPickY = y;
}

export function registerBillboardPickContributor(scene: SceneContext, system: BillboardSpriteSystem): void {
    const sys = system as BillboardSpriteSystem & { _pickContributorRegistered?: boolean };
    if (sys._pickContributorRegistered) {
        return;
    }
    sys._pickContributorRegistered = true;

    const ctx = scene as SceneContextInternal;
    const engine = ctx.engine as EngineContextInternal;

    let pickUbo: GPUBuffer | null = null;
    let bindGroup: GPUBindGroup | null = null;
    let cachedStorageBuffer: GPUBuffer | null = null;
    const uboScratch = new ArrayBuffer(BILLBOARD_PICK_UBO_BYTES);
    const uboF32 = new Float32Array(uboScratch);
    const uboU32 = new Uint32Array(uboScratch);

    const isCutout = system.blendMode === "cutout";
    const variant = system._variant;

    const contributor: BillboardContributor = {
        rangeStart: 0,
        rangeEnd: 0,
        draw(pctx: PickPassContext, nextPickId: number): number {
            if (!system.visible || system._storage.count === 0 || !system._storage.gpuBuffer) {
                this.rangeStart = nextPickId;
                this.rangeEnd = nextPickId;
                return nextPickId;
            }
            const device = engine.device;
            const { pipeline, systemBGL } = getBillboardPickPipeline(engine, variant, isCutout);

            const count = system._storage.count;
            const indexArr = new Uint32Array(count);
            for (let i = 0; i < count; i++) {
                indexArr[i] = i;
            }
            const indexBuffer = device.createBuffer({
                label: "billboard-pick-index",
                size: Math.max(4, count * 4),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(indexBuffer, 0, indexArr.buffer, indexArr.byteOffset, count * 4);
            pctx.tempBuffers.push(indexBuffer);

            const wm = pctx.camera.worldMatrix;
            uboF32[0] = wm[0]!;
            uboF32[1] = wm[1]!;
            uboF32[2] = wm[2]!;
            uboF32[3] = wm[12]!;
            uboF32[4] = wm[4]!;
            uboF32[5] = wm[5]!;
            uboF32[6] = wm[6]!;
            uboF32[7] = wm[13]!;
            uboF32[8] = wm[8]!;
            uboF32[9] = wm[9]!;
            uboF32[10] = wm[10]!;
            uboF32[11] = wm[14]!;
            const lockAxis = system._lockAxis;
            uboF32[12] = lockAxis ? lockAxis[0] : 0;
            uboF32[13] = lockAxis ? lockAxis[1] : 1;
            uboF32[14] = lockAxis ? lockAxis[2] : 0;
            uboF32[15] = 0;
            uboU32[16] = nextPickId;
            uboF32[17] = system.alphaCutoff;
            uboF32[18] = 0;
            uboF32[19] = 0;
            if (!pickUbo) {
                pickUbo = device.createBuffer({
                    label: "billboard-pick-system-ubo",
                    size: BILLBOARD_PICK_UBO_BYTES,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                ctx._disposables.push(() => {
                    pickUbo?.destroy();
                    pickUbo = null;
                });
            }
            device.queue.writeBuffer(pickUbo, 0, uboScratch);

            if (!bindGroup || system._storage.gpuBuffer !== cachedStorageBuffer) {
                bindGroup = device.createBindGroup({
                    label: "billboard-pick-system-bg",
                    layout: systemBGL,
                    entries: [
                        { binding: 0, resource: system.atlas.texture.view },
                        { binding: 1, resource: system.atlas.texture.sampler },
                        { binding: 2, resource: { buffer: pickUbo } },
                        { binding: 3, resource: { buffer: system._storage.gpuBuffer } },
                    ],
                });
                cachedStorageBuffer = system._storage.gpuBuffer;
            }
            this.rangeStart = nextPickId;
            this.rangeEnd = nextPickId + count;

            pctx.pass.setPipeline(pipeline);
            pctx.pass.setBindGroup(0, pctx.sceneBG);
            pctx.pass.setBindGroup(1, bindGroup);
            pctx.pass.setVertexBuffer(0, indexBuffer);
            pctx.pass.draw(6, count);
            return nextPickId + count;
        },
        resolve(pickId: number, worldPoint: [number, number, number] | null, _depth: number): PickingInfo | null {
            if (pickId < this.rangeStart || pickId >= this.rangeEnd) {
                return null;
            }
            const localIndex = pickId - this.rangeStart;
            const off = localIndex * SPRITE_BILLBOARD_STRIDE;
            const data = system._storage.data;
            const wx = data[off + 0]!;
            const wy = data[off + 1]!;
            const wz = data[off + 2]!;
            let uv: [number, number] = [0.5, 0.5];
            const cam = ctx.camera;
            if (worldPoint && system._basisFn && cam) {
                const wm = cam.worldMatrix;
                const camRight: [number, number, number] = [wm[0]!, wm[1]!, wm[2]!];
                const camUp: [number, number, number] = [wm[4]!, wm[5]!, wm[6]!];
                const camPos: [number, number, number] = [wm[12]!, wm[13]!, wm[14]!];
                const basis = system._basisFn([wx, wy, wz], camRight, camUp, camPos);
                const meta = system._meta[localIndex]!;
                const sw = meta.sizeWorld[0];
                const sh = meta.sizeWorld[1];
                if (sw > 0 && sh > 0) {
                    const dx = worldPoint[0] - wx;
                    const dy = worldPoint[1] - wy;
                    const dz = worldPoint[2] - wz;
                    const localX = dx * basis.right[0] + dy * basis.right[1] + dz * basis.right[2];
                    const localY = dx * basis.up[0] + dy * basis.up[1] + dz * basis.up[2];
                    const sin = Math.sin(meta.rotation);
                    const cos = Math.cos(meta.rotation);
                    const localXr = localX * cos + localY * sin;
                    const localYr = -localX * sin + localY * cos;
                    const u = Math.min(1, Math.max(0, localXr / sw + meta.pivot[0]));
                    const v = Math.min(1, Math.max(0, localYr / sh + meta.pivot[1]));
                    uv = [u, v];
                }
            }
            const info = createEmptyPickingInfo();
            info.hit = true;
            info.pickedPoint = worldPoint;
            (info as unknown as { _spritePick: SpritePickInfo })._spritePick = {
                layerOrSystem: system,
                spriteIndex: localIndex,
                uv,
                screenPx: [_lastPickX, _lastPickY],
                worldPosition: [wx, wy, wz],
            };
            return info;
        },
    };

    getOrCreatePickContributors(scene).push(contributor);
}
