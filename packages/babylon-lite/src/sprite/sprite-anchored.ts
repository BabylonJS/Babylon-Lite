/**
 * AnchoredSpriteLayer — fixed-pixel-size sprites anchored at world positions.
 *
 * Sprites are projected through the 3D camera; the quad is then expanded in
 * pixels in clip space so screen size is invariant to camera distance.
 *
 * Per-instance layout (96 B = 24 floats) — see docs/architecture/26-sprites.md
 * § AnchoredSpriteLayer:
 *   0..2   worldPos
 *   3      depthBias
 *   4..5   offsetPx
 *   6..7   sizePx
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

/** Floats per sprite for AnchoredSpriteLayer (96 B). */
export const SPRITE_ANCHORED_STRIDE = 24;

export interface AnchoredSpriteLayerOptions {
    capacity?: number;
    blendMode?: SpriteBlendMode;
    pixelSnap?: boolean;
    opacity?: number;
    visible?: boolean;
    order?: number;
    /** When true, anchor depth is honored (sprite hidden behind closer geometry). Default true. */
    depthTest?: boolean;
    /** Cutoff threshold for `cutout` blend mode. Default 0.5. */
    alphaCutoff?: number;
}

export interface AnchoredSpriteInit {
    position: [number, number, number];
    sizePx?: [number, number];
    frame?: SpriteFrameRef;
    rotation?: number;
    pivot?: [number, number];
    offsetPx?: [number, number];
    depthBias?: number;
    color?: [number, number, number, number];
    flipX?: boolean;
    flipY?: boolean;
    visible?: boolean;
    pickable?: boolean;
    clip?: SpriteClipState | null;
}

/** @internal CPU-only per-slot metadata used by picking + update merging. */
interface AnchoredSlotMeta {
    pickable: boolean;
    visible: boolean;
    sizePx: [number, number];
    pivot: [number, number];
    offsetPx: [number, number];
    rotation: number;
    frameIndex: number;
}

export interface AnchoredSpriteLayer {
    readonly _entityType: "anchored-sprite-layer";
    readonly atlas: SpriteAtlas;
    blendMode: SpriteBlendMode;
    pixelSnap: boolean;
    opacity: number;
    visible: boolean;
    order: number;
    depthTest: boolean;
    alphaCutoff: number;
    count: number;

    /** @internal flat instance storage. */
    readonly _storage: SpriteStorage;
    /** @internal per-slot CPU metadata (length tracks storage.count). */
    readonly _meta: AnchoredSlotMeta[];
    /** @internal sparse: index → animation state. */
    readonly _clips: Map<number, SpriteClipState>;
    /** @internal monotonic counter bumped on add/remove/position change — drives transparent re-sort. */
    _sortVersion: number;
    /** @internal deferred renderable build (set by addToScene). */
    _deferredBuild?: (scene: SceneContext) => Promise<void>;
}

export function createAnchoredSpriteLayer(atlas: SpriteAtlas, opts: AnchoredSpriteLayerOptions = {}): AnchoredSpriteLayer {
    const layer: AnchoredSpriteLayer = {
        _entityType: "anchored-sprite-layer",
        atlas,
        blendMode: opts.blendMode ?? "alpha",
        pixelSnap: opts.pixelSnap ?? false,
        opacity: opts.opacity ?? 1,
        visible: opts.visible ?? true,
        order: opts.order ?? 0,
        depthTest: opts.depthTest ?? true,
        alphaCutoff: opts.alphaCutoff ?? 0.5,
        count: 0,
        _storage: createSpriteStorage(opts.capacity ?? 64, SPRITE_ANCHORED_STRIDE),
        _meta: [],
        _clips: new Map(),
        _sortVersion: 0,
    };
    // Dynamic-import the renderable + picking-aware deferred build hook so
    // sprite-free scenes never load anchored bytes.
    layer._deferredBuild = async (scene): Promise<void> => {
        const mod = await import("./sprite-anchored-renderable.js");
        await mod.buildAnchoredSpriteRenderable(layer, scene);
    };
    return layer;
}

function packSlot(layer: AnchoredSpriteLayer, index: number, init: AnchoredSpriteInit, frameIndex: number): void {
    const atlas = layer.atlas;
    const frame = atlas.frames[frameIndex]!;
    const sizePx = init.sizePx ?? frame.sourceSizePx;
    const pivot = init.pivot ?? frame.pivot;
    const offsetPx = init.offsetPx ?? [0, 0];
    const depthBias = init.depthBias ?? 0;
    const rotation = init.rotation ?? 0;
    const visible = init.visible !== false;
    const sin = Math.sin(rotation);
    const cos = Math.cos(rotation);
    const color = init.color ?? [1, 1, 1, 1];
    const flipX = init.flipX === true ? 1 : 0;
    const flipY = init.flipY === true ? 1 : 0;
    const pickable = init.pickable !== false ? 1 : 0;
    const out: [number, number] = visible ? [sizePx[0]!, sizePx[1]!] : [0, 0];
    const off = index * SPRITE_ANCHORED_STRIDE;
    const d = layer._storage.data;
    d[off + 0] = init.position[0];
    d[off + 1] = init.position[1];
    d[off + 2] = init.position[2];
    d[off + 3] = depthBias;
    d[off + 4] = offsetPx[0]!;
    d[off + 5] = offsetPx[1]!;
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
    // flagsAndPad.z reserved for picking parity with billboards (anchored uses CPU pick).
    d[off + 22] = pickable;
    d[off + 23] = 0;

    layer._meta[index] = {
        pickable: init.pickable !== false,
        visible,
        sizePx: [sizePx[0]!, sizePx[1]!],
        pivot: [pivot[0]!, pivot[1]!],
        offsetPx: [offsetPx[0]!, offsetPx[1]!],
        rotation,
        frameIndex,
    };
}

export function addAnchoredSprite(layer: AnchoredSpriteLayer, sprite: AnchoredSpriteInit): number {
    const index = layer._storage.count;
    ensureCapacity(layer._storage, index + 1);
    layer._storage.count = index + 1;
    layer.count = layer._storage.count;
    const frameIndex = resolveSpriteFrame(layer.atlas, sprite.frame ?? 0);
    packSlot(layer, index, sprite, frameIndex);
    if (sprite.clip) {
        layer._clips.set(index, sprite.clip);
    }
    markDirty(layer._storage, index, index + 1);
    layer._sortVersion++;
    return index;
}

export function updateAnchoredSprite(layer: AnchoredSpriteLayer, index: number, patch: Partial<AnchoredSpriteInit>): void {
    const meta = layer._meta[index]!;
    const off = index * SPRITE_ANCHORED_STRIDE;
    const d = layer._storage.data;
    const merged: AnchoredSpriteInit = {
        position: patch.position ?? [d[off + 0]!, d[off + 1]!, d[off + 2]!],
        depthBias: patch.depthBias ?? d[off + 3]!,
        offsetPx: patch.offsetPx ?? meta.offsetPx,
        sizePx: patch.sizePx ?? meta.sizePx,
        pivot: patch.pivot ?? meta.pivot,
        rotation: patch.rotation ?? meta.rotation,
        color: patch.color ?? [d[off + 16]!, d[off + 17]!, d[off + 18]!, d[off + 19]!],
        flipX: patch.flipX ?? d[off + 20]! > 0.5,
        flipY: patch.flipY ?? d[off + 21]! > 0.5,
        visible: patch.visible ?? meta.visible,
        pickable: patch.pickable ?? meta.pickable,
        frame: patch.frame ?? meta.frameIndex,
    };
    const frameIndex = resolveSpriteFrame(layer.atlas, merged.frame ?? 0);
    packSlot(layer, index, merged, frameIndex);
    if (patch.clip !== undefined) {
        if (patch.clip === null) {
            layer._clips.delete(index);
        } else {
            layer._clips.set(index, patch.clip);
        }
    }
    markDirty(layer._storage, index, index + 1);
    if (patch.position !== undefined) {
        layer._sortVersion++;
    }
}

export function removeAnchoredSprite(layer: AnchoredSpriteLayer, index: number): void {
    const last = layer._storage.count - 1;
    if (index !== last) {
        layer._meta[index] = layer._meta[last]!;
        const lastClip = layer._clips.get(last);
        layer._clips.delete(index);
        if (lastClip) {
            layer._clips.delete(last);
            layer._clips.set(index, lastClip);
        }
    } else {
        layer._clips.delete(index);
    }
    layer._meta.length = last;
    swapRemove(layer._storage, index);
    layer.count = layer._storage.count;
    // Only the swapped slot needs re-upload; the popped tail is past `count`.
    if (index !== last) {
        markDirty(layer._storage, index, index + 1);
    }
    layer._sortVersion++;
}

export function setAnchoredSpriteFrame(layer: AnchoredSpriteLayer, index: number, frame: SpriteFrameRef): void {
    const frameIndex = resolveSpriteFrame(layer.atlas, frame);
    const meta = layer._meta[index]!;
    if (meta.frameIndex === frameIndex) {
        return;
    }
    meta.frameIndex = frameIndex;
    const f = layer.atlas.frames[frameIndex]!;
    const off = index * SPRITE_ANCHORED_STRIDE;
    const d = layer._storage.data;
    d[off + 12] = f.uvMin[0];
    d[off + 13] = f.uvMin[1];
    d[off + 14] = f.uvMax[0];
    d[off + 15] = f.uvMax[1];
    markDirty(layer._storage, index, index + 1);
}

export function playAnchoredSpriteClip(layer: AnchoredSpriteLayer, index: number, clip: string, loop?: boolean): void {
    const clipIndex = layer.atlas._clipByName.get(clip);
    if (clipIndex === undefined) {
        throw new Error(`Sprite clip '${clip}' not found in atlas`);
    }
    const state = createSpriteClipState({ clipIndex, loopOverride: loop ?? null });
    layer._clips.set(index, state);
}

export function stopAnchoredSpriteClip(layer: AnchoredSpriteLayer, index: number): void {
    const s = layer._clips.get(index);
    if (s) {
        s.playing = false;
    }
}

/** @internal Advance all active clips by `deltaMs` and update frame UVs. */
export function _tickAnchoredSpriteClips(layer: AnchoredSpriteLayer, deltaMs: number): void {
    if (layer._clips.size === 0) {
        return;
    }
    for (const [index, state] of layer._clips) {
        const newFrame = advanceSpriteClip(layer.atlas, state, deltaMs);
        setAnchoredSpriteFrame(layer, index, newFrame);
    }
}
