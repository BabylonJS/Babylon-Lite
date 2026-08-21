/**
 * Floating-origin precision at the BILLBOARD anchor boundary.
 *
 * `floating-origin-upload.test.ts` fixes the standard for the mesh path: at
 * world scale the F32 ULP is coarse (~0.0625m at 1e6), so the eye-relative
 * subtraction has to happen in F64 BEFORE the F32 store, and
 * `packMat4IntoF32WithOffset` is asserted to land the small delta exactly.
 *
 * Billboard anchors take the opposite order. `addBillboardSpriteIndex` stores
 * the caller's position straight into `_instanceData`, which is an F32 array,
 * and `uploadBillboardInstances` subtracts the camera offset from that
 * already-quantized value. The subtraction is then exact but meaningless: the
 * sub-ULP detail is gone one step earlier, so a billboard cannot resolve
 * motion finer than the ULP at its own world magnitude no matter how close to
 * the camera it is.
 *
 * These cases pin the mesh path's behaviour and the billboard path's side by
 * side at the same magnitude and the same delta, so the gap is a measured
 * number rather than an argument.
 *
 * The fix adds `_anchor`, an F64 shadow that `writeInstance` also consults
 * when a patch omits `position` (e.g. a color-only update), so a per-frame
 * tween on a stationary far sprite can't fall back to the already-quantized
 * `_instanceData` row and re-round the anchor down. The last case below pins
 * that carry-forward path directly.
 */
import { describe, it, expect } from "vitest";

import {
    createFacingBillboardSystem,
    addBillboardSpriteIndex,
    updateBillboardSpriteIndex,
    BILLBOARD_INSTANCE_FLOATS_PER_SPRITE,
} from "../../../packages/babylon-lite/src/sprite/billboard-sprite";
import { createBillboardInstanceSortScratch, uploadBillboardInstances } from "../../../packages/babylon-lite/src/sprite/billboard-pipeline";
import { packMat4IntoF32WithOffset } from "../../../packages/babylon-lite/src/large-world/pack-mat4-with-offset";
import { allocateMat4, _setHpmAllocator, _resetMatrixAllocatorForTests } from "../../../packages/babylon-lite/src/math/_matrix-allocator";
import { allocateF64Mat4 } from "../../../packages/babylon-lite/src/math/_mat4-storage-f64";
import type { SpriteAtlas } from "../../../packages/babylon-lite/src/sprite/shared/sprite-atlas";

/** Manywhere's actual playable magnitude: bodies orbit a star-centred origin at 0.7e6 - 6.5e6 metres. */
const FAR = 1_000_000;
/** Well under half the F32 ULP at FAR (0.0625), so an F32 store at world scale must lose it entirely. */
const DELTA = 1.5e-3;

function atlas(): SpriteAtlas {
    return {
        texture: { width: 4, height: 4 } as never,
        frames: [{ u0: 0, v0: 0, u1: 1, v1: 1, widthPx: 4, heightPx: 4 }],
        frameByName: new Map(),
    } as unknown as SpriteAtlas;
}

/** Captures the bytes handed to the GPU without needing a device. */
function captureUpload(): { device: GPUDevice; uploaded: () => Float32Array } {
    let captured: Float32Array | null = null;
    const device = {
        queue: {
            writeBuffer(_buffer: unknown, _offset: number, data: ArrayBuffer, byteOffset: number, byteLength: number) {
                captured = new Float32Array(data.slice(byteOffset, byteOffset + byteLength));
            },
        },
    } as unknown as GPUDevice;
    return {
        device,
        uploaded: () => {
            if (!captured) throw new Error("nothing was uploaded");
            return captured;
        },
    };
}

function uploadAnchor(position: [number, number, number], foX: number, foY: number, foZ: number): Float32Array {
    const system = createFacingBillboardSystem(atlas(), { capacity: 1 });
    addBillboardSpriteIndex(system, { position, sizeWorld: [1, 1] });
    const { device, uploaded } = captureUpload();
    uploadBillboardInstances(device, system, {} as GPUBuffer, -1, foX, foY, foZ, createBillboardInstanceSortScratch());
    return uploaded().subarray(0, BILLBOARD_INSTANCE_FLOATS_PER_SPRITE);
}

describe("billboard anchors under floating origin", () => {
    it("the mesh path recovers a sub-ULP delta at the same magnitude — the standard being compared against", () => {
        _setHpmAllocator(allocateF64Mat4);
        try {
            const world = allocateMat4() as unknown as Float64Array;
            world[0] = 1;
            world[5] = 1;
            world[10] = 1;
            world[15] = 1;
            world[12] = FAR + DELTA;
            const view = new Float32Array(16);
            packMat4IntoF32WithOffset(view, world as never, 0, 0, FAR, 0, 0);
            expect(view[12]).toBe(Math.fround(DELTA));
        } finally {
            _resetMatrixAllocatorForTests();
        }
    });

    it("a billboard anchor at the same magnitude loses the same delta", () => {
        const instance = uploadAnchor([FAR + DELTA, 0, 0], FAR, 0, 0);
        expect(instance[0]).toBe(Math.fround(DELTA));
    });

    it("two anchors a sub-ULP step apart stay distinct after the eye-relative subtraction", () => {
        // The visible symptom, not the arithmetic: a particle drifting slowly
        // past the camera must move, not snap. At FAR the ULP is 0.0625m and a
        // ship plume's sprites are 0.16-0.8m across, so a snap of that size is
        // a quarter of a sprite.
        const first = uploadAnchor([FAR, 0, 0], FAR, 0, 0);
        const second = uploadAnchor([FAR + DELTA, 0, 0], FAR, 0, 0);
        expect(second[0]).not.toBe(first[0]);
    });

    it("a position-omitting update carries the anchor forward from `_anchor`, not from the quantized `_instanceData` row", () => {
        // `writeInstance` resolves a missing `position` on an update by reading
        // `system._anchor` (F64, exact). The regression this guards against is a
        // fallback to `prev` instead — a view onto the F32 `_instanceData` row,
        // which for this sprite already reads back as plain FAR because DELTA is
        // sub-ULP: `Math.fround(FAR + DELTA) === FAR`. That fallback would silently
        // overwrite the F64 anchor with the rounded value on the very first update
        // that doesn't touch position, permanently losing the delta from then on —
        // exactly the per-frame case of a color/alpha tween on a far sprite that
        // never moves. One color-only update must not be able to do that.
        const system = createFacingBillboardSystem(atlas(), { capacity: 2 });
        addBillboardSpriteIndex(system, { position: [FAR, 0, 0], sizeWorld: [1, 1] });
        addBillboardSpriteIndex(system, { position: [FAR + DELTA, 0, 0], sizeWorld: [1, 1] });

        // Per-frame alpha/color tween on the far sprite — no `position` in the patch.
        updateBillboardSpriteIndex(system, 1, { color: [1, 0, 0, 0.5] });

        const { device, uploaded } = captureUpload();
        uploadBillboardInstances(device, system, {} as GPUBuffer, -1, FAR, 0, 0, createBillboardInstanceSortScratch());
        const stride = BILLBOARD_INSTANCE_FLOATS_PER_SPRITE;
        const first = uploaded().subarray(0, stride);
        const second = uploaded().subarray(stride, stride * 2);

        expect(second[0]).toBe(Math.fround(DELTA));
        expect(second[0]).not.toBe(first[0]);
    });
});
