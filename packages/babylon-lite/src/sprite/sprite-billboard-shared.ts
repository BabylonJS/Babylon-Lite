/**
 * Billboard sprite system — shared types, factories' common state, and the
 * mutator API used by all three variants (Facing, YawLocked, AxisLocked).
 *
 * The three variants share an identical per-instance data layout (24 floats /
 * 96 B — same as AnchoredSpriteLayer) but differ in how the vertex shader
 * orients the quad. There is **no shared mode enum and no per-frame branch**:
 * the user picks a factory in `sprite-billboard-{facing,yaw,axis}.ts`, each of
 * which dynamic-imports its own renderable + composer.
 *
 * Per-instance layout (96 B = 24 floats) — see docs/architecture/26-sprites.md
 * § BillboardSpriteSystem:
 *   0..2   worldPos
 *   3      reserved (depthBias slot from the shared 24-float anchored layout, packed as 0)
 *   4..5   reserved (offsetPx slot from the shared layout, packed as 0)
 *   6..7   sizeWorld   ← world units (vs. sizePx for anchored)
 *   8..9   pivot
 *   10..11 sinCos
 *   12..15 uvRect
 *   16..19 color
 *   20..23 flagsAndPad (flipX, flipY, 0, 0)
 */

import type { SceneContext } from "../scene/scene.js";
import type { SpriteAtlas, SpriteBlendMode, SpriteFrameRef } from "./shared/sprite-atlas.js";
import { resolveSpriteFrame } from "./shared/sprite-atlas.js";
import type { SpriteClipState } from "./shared/sprite-animation.js";
import { advanceSpriteClip, createSpriteClipState } from "./shared/sprite-animation.js";
import type { SpriteStorage } from "./shared/sprite-gpu.js";
import { createSpriteStorage, ensureCapacity, markDirty, swapRemove } from "./shared/sprite-gpu.js";

/** Floats per sprite for BillboardSpriteSystem (96 B). */
export const SPRITE_BILLBOARD_STRIDE = 24;

/**
 * Bridge interface implemented by `BillboardSpriteHandle` for the renderable walker.
 * @internal
 */
export interface IParentedBillboardHandle {
    readonly id: number;
    readonly worldMatrix: import("../math/types.js").Mat4;
}

/** Internal tag identifying which billboard variant a system was built from. */
export type BillboardVariant = "facing" | "yaw" | "axis";

export interface BillboardSpriteSystemOptions {
    capacity?: number;
    blendMode?: SpriteBlendMode;
    opacity?: number;
    visible?: boolean;
    order?: number;
    /** Default false for blended billboards, true for cutout. */
    depthWrite?: boolean;
    /** Cutoff threshold in [0,1]. Used only when blendMode === "cutout". Default 0.5. */
    alphaCutoff?: number;
}

export interface BillboardSpriteInit {
    position: [number, number, number];
    sizeWorld: [number, number];
    frame?: SpriteFrameRef;
    rotation?: number;
    pivot?: [number, number];
    color?: [number, number, number, number];
    flipX?: boolean;
    flipY?: boolean;
    visible?: boolean;
    pickable?: boolean;
    clip?: SpriteClipState | null;
}

/** @internal CPU-only per-slot metadata used by picking + update merging. */
export interface BillboardSlotMeta {
    pickable: boolean;
    visible: boolean;
    sizeWorld: [number, number];
    pivot: [number, number];
    rotation: number;
    frameIndex: number;
}

export interface BillboardSpriteSystem {
    readonly _entityType: "billboard-sprite-system";
    readonly atlas: SpriteAtlas;
    blendMode: SpriteBlendMode;
    opacity: number;
    visible: boolean;
    order: number;
    depthWrite: boolean;
    alphaCutoff: number;
    count: number;

    /** @internal which variant — fixed at factory creation, never inspected on the render path. */
    readonly _variant: BillboardVariant;
    /** @internal lock axis (axis-locked variant only). Normalized. */
    readonly _lockAxis: [number, number, number] | null;
    /** @internal flat instance storage. */
    readonly _storage: SpriteStorage;
    /** @internal per-slot CPU metadata. */
    readonly _meta: BillboardSlotMeta[];
    /** @internal sparse: index → animation state. */
    readonly _clips: Map<number, SpriteClipState>;
    /** @internal monotonic counter bumped on add/remove/position change. */
    _sortVersion: number;
    /** @internal monotonically increasing handle id source. */
    _nextHandleId: number;
    /** @internal lazily allocated when the first handle is created. */
    _idToIndex: Map<number, number> | null;
    /** @internal lazily allocated parallel to storage capacity. */
    _indexToId: Uint32Array | null;
    /** @internal lazily allocated set of currently-parented handles. */
    _parentedHandles: Set<IParentedBillboardHandle> | null;
    /** @internal function-pointer hook installed by sprite-billboard-handle.ts on first parenting. */
    _parentedHandlesWalker: ((system: BillboardSpriteSystem) => void) | null;
    /**
     * @internal Variant-specific quad basis closure used by the GPU pick contributor
     * to reconstruct UV from a 3D hit point. Optionally attached by each variant
     * factory; absent ⇒ pick UV defaults to (0.5, 0.5).
     */
    _basisFn?: (
        worldPos: [number, number, number],
        camRight: [number, number, number],
        camUp: [number, number, number],
        camPos: [number, number, number]
    ) => { right: [number, number, number]; up: [number, number, number] };
    /** @internal deferred renderable build (set by factory). */
    _deferredBuild?: (scene: SceneContext) => Promise<void>;
}

/** @internal Shared system constructor used by the three factories. */
export function _createBillboardSystem(
    atlas: SpriteAtlas,
    variant: BillboardVariant,
    lockAxis: [number, number, number] | null,
    opts: BillboardSpriteSystemOptions
): BillboardSpriteSystem {
    const blendMode = opts.blendMode ?? "alpha";
    const isCutout = blendMode === "cutout";
    return {
        _entityType: "billboard-sprite-system",
        atlas,
        blendMode,
        opacity: opts.opacity ?? 1,
        visible: opts.visible ?? true,
        order: opts.order ?? 0,
        // Default depth-write: off for blended families, on for cutout. Override via opts.
        depthWrite: opts.depthWrite ?? isCutout,
        alphaCutoff: opts.alphaCutoff ?? 0.5,
        count: 0,
        _variant: variant,
        _lockAxis: lockAxis,
        _storage: createSpriteStorage(opts.capacity ?? 64, SPRITE_BILLBOARD_STRIDE),
        _meta: [],
        _clips: new Map(),
        _sortVersion: 0,
        _nextHandleId: 1,
        _idToIndex: null,
        _indexToId: null,
        _parentedHandles: null,
        _parentedHandlesWalker: null,
    };
}

function packSlot(system: BillboardSpriteSystem, index: number, init: BillboardSpriteInit, frameIndex: number): void {
    const atlas = system.atlas;
    const frame = atlas.frames[frameIndex]!;
    const sizeWorld = init.sizeWorld;
    const pivot = init.pivot ?? frame.pivot;
    const rotation = init.rotation ?? 0;
    const visible = init.visible !== false;
    const sin = Math.sin(rotation);
    const cos = Math.cos(rotation);
    const color = init.color ?? [1, 1, 1, 1];
    const flipX = init.flipX === true ? 1 : 0;
    const flipY = init.flipY === true ? 1 : 0;
    const out: [number, number] = visible ? [sizeWorld[0], sizeWorld[1]] : [0, 0];
    const off = index * SPRITE_BILLBOARD_STRIDE;
    const d = system._storage.data;
    d[off + 0] = init.position[0];
    d[off + 1] = init.position[1];
    d[off + 2] = init.position[2];
    // Slots 3, 4, 5 reserved (anchored uses depthBias + offsetPx here).
    d[off + 3] = 0;
    d[off + 4] = 0;
    d[off + 5] = 0;
    d[off + 6] = out[0];
    d[off + 7] = out[1];
    d[off + 8] = pivot[0]!;
    d[off + 9] = pivot[1]!;
    d[off + 10] = sin;
    d[off + 11] = cos;
    d[off + 12] = frame.uvMin[0];
    d[off + 13] = frame.uvMin[1];
    d[off + 14] = frame.uvMax[0];
    d[off + 15] = frame.uvMax[1];
    d[off + 16] = color[0]!;
    d[off + 17] = color[1]!;
    d[off + 18] = color[2]!;
    d[off + 19] = color[3]!;
    d[off + 20] = flipX;
    d[off + 21] = flipY;
    d[off + 22] = 0;
    d[off + 23] = 0;

    system._meta[index] = {
        pickable: init.pickable !== false,
        visible,
        sizeWorld: [sizeWorld[0], sizeWorld[1]],
        pivot: [pivot[0]!, pivot[1]!],
        rotation,
        frameIndex,
    };
}

export function addBillboardSpriteIndex(system: BillboardSpriteSystem, sprite: BillboardSpriteInit): number {
    const index = system._storage.count;
    ensureCapacity(system._storage, index + 1);
    system._storage.count = index + 1;
    system.count = system._storage.count;
    const frameIndex = resolveSpriteFrame(system.atlas, sprite.frame ?? 0);
    packSlot(system, index, sprite, frameIndex);
    if (sprite.clip) {
        system._clips.set(index, sprite.clip);
    }
    markDirty(system._storage, index, index + 1);
    system._sortVersion++;
    return index;
}

export function updateBillboardSpriteIndex(system: BillboardSpriteSystem, index: number, patch: Partial<BillboardSpriteInit>): void {
    const meta = system._meta[index]!;
    const off = index * SPRITE_BILLBOARD_STRIDE;
    const d = system._storage.data;
    const merged: BillboardSpriteInit = {
        position: patch.position ?? [d[off + 0]!, d[off + 1]!, d[off + 2]!],
        sizeWorld: patch.sizeWorld ?? meta.sizeWorld,
        pivot: patch.pivot ?? meta.pivot,
        rotation: patch.rotation ?? meta.rotation,
        color: patch.color ?? [d[off + 16]!, d[off + 17]!, d[off + 18]!, d[off + 19]!],
        flipX: patch.flipX ?? d[off + 20]! > 0.5,
        flipY: patch.flipY ?? d[off + 21]! > 0.5,
        visible: patch.visible ?? meta.visible,
        pickable: patch.pickable ?? meta.pickable,
        frame: patch.frame ?? meta.frameIndex,
    };
    const frameIndex = resolveSpriteFrame(system.atlas, merged.frame ?? 0);
    packSlot(system, index, merged, frameIndex);
    if (patch.clip !== undefined) {
        if (patch.clip === null) {
            system._clips.delete(index);
        } else {
            system._clips.set(index, patch.clip);
        }
    }
    markDirty(system._storage, index, index + 1);
    if (patch.position !== undefined) {
        system._sortVersion++;
    }
}

export function removeBillboardSpriteIndex(system: BillboardSpriteSystem, index: number): void {
    const last = system._storage.count - 1;
    if (index !== last) {
        system._meta[index] = system._meta[last]!;
        const lastClip = system._clips.get(last);
        system._clips.delete(index);
        if (lastClip) {
            system._clips.delete(last);
            system._clips.set(index, lastClip);
        }
        if (system._indexToId !== null && system._idToIndex !== null) {
            const movedId = system._indexToId[last]!;
            if (movedId !== 0) {
                system._idToIndex.set(movedId, index);
                system._indexToId[index] = movedId;
            } else {
                system._indexToId[index] = 0;
            }
            system._indexToId[last] = 0;
        }
    } else {
        system._clips.delete(index);
        if (system._indexToId !== null) {
            system._indexToId[index] = 0;
        }
    }
    system._meta.length = last;
    swapRemove(system._storage, index);
    system.count = system._storage.count;
    markDirty(system._storage, Math.min(index, last), last + 1);
    system._sortVersion++;
}

/** @internal Clears the handle id at `index` so the following swap-remove
 * does not rebind it to the moved-in slot. */
export function _removeBillboardHandleId(system: BillboardSpriteSystem, index: number): void {
    if (system._indexToId === null || system._idToIndex === null) {
        return;
    }
    const id = system._indexToId[index]!;
    if (id !== 0) {
        system._idToIndex.delete(id);
    }
}

export function setBillboardSpriteFrameIndex(system: BillboardSpriteSystem, index: number, frame: SpriteFrameRef): void {
    const frameIndex = resolveSpriteFrame(system.atlas, frame);
    const meta = system._meta[index]!;
    if (meta.frameIndex === frameIndex) {
        return;
    }
    meta.frameIndex = frameIndex;
    const f = system.atlas.frames[frameIndex]!;
    const off = index * SPRITE_BILLBOARD_STRIDE;
    const d = system._storage.data;
    d[off + 12] = f.uvMin[0];
    d[off + 13] = f.uvMin[1];
    d[off + 14] = f.uvMax[0];
    d[off + 15] = f.uvMax[1];
    markDirty(system._storage, index, index + 1);
}

export function playBillboardSpriteClipIndex(system: BillboardSpriteSystem, index: number, clip: string, loop?: boolean): void {
    const clipIndex = system.atlas._clipByName.get(clip);
    if (clipIndex === undefined) {
        throw new Error(`Sprite clip '${clip}' not found in atlas`);
    }
    const state = createSpriteClipState({ clipIndex, loopOverride: loop ?? null });
    system._clips.set(index, state);
}

export function stopBillboardSpriteClipIndex(system: BillboardSpriteSystem, index: number): void {
    const s = system._clips.get(index);
    if (s) {
        s.playing = false;
    }
}

/** @internal Advance all active clips by `deltaMs` and update frame UVs. */
export function _tickBillboardSpriteClips(system: BillboardSpriteSystem, deltaMs: number): void {
    if (system._clips.size === 0) {
        return;
    }
    for (const [index, state] of system._clips) {
        const newFrame = advanceSpriteClip(system.atlas, state, deltaMs);
        setBillboardSpriteFrameIndex(system, index, newFrame);
    }
}
