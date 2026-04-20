/**
 * Sprite2DLayer — pixel-coordinate 2D sprite layer.
 *
 * Public-facing factory + mutators. The actual GPU pipeline & draw is in
 * `sprite-2d-renderable.ts` (dynamic-imported). This file is the slim
 * data layer: pure data, no GPU handles.
 */

import type { EngineContextInternal } from "../engine/engine.js";
import type { SpriteAtlas, SpriteBlendMode, SpriteFrameRef } from "./shared/sprite-atlas.js";
import { resolveSpriteFrame } from "./shared/sprite-atlas.js";
import type { SpriteClipState } from "./shared/sprite-animation.js";
import { advanceSpriteClip, createSpriteClipState } from "./shared/sprite-animation.js";
import type { SpriteStorage } from "./shared/sprite-gpu.js";
import { createSpriteStorage, ensureCapacity, markDirty, swapRemove } from "./shared/sprite-gpu.js";
import type { Renderable, SceneUniformUpdater } from "../render/renderable.js";

/** Floats per sprite for Sprite2DLayer (80 B). */
export const SPRITE_2D_STRIDE = 20;

/** Per-layer pan/zoom/rotation in pixel space. */
export interface Sprite2DView {
    positionPx: [number, number];
    zoom: number;
    rotation: number;
}

export interface Sprite2DLayerOptions {
    capacity?: number;
    blendMode?: SpriteBlendMode;
    pixelSnap?: boolean;
    opacity?: number;
    visible?: boolean;
    order?: number;
    /** Cutoff threshold for `cutout` blend mode. Default 0.5. */
    alphaCutoff?: number;
    view?: Partial<Sprite2DView>;
}

export interface Sprite2DInit {
    positionPx: [number, number];
    sizePx?: [number, number];
    frame?: SpriteFrameRef;
    rotation?: number;
    pivot?: [number, number];
    color?: [number, number, number, number];
    flipX?: boolean;
    flipY?: boolean;
    layer?: number;
    visible?: boolean;
    pickable?: boolean;
    clip?: SpriteClipState | null;
}

/** @internal stored per-sprite metadata (sparse — only what CPU needs). */
interface Sprite2DSlotMeta {
    pickable: boolean;
    visible: boolean;
    sizePx: [number, number];
    pivot: [number, number];
    rotation: number;
    frameIndex: number;
}

export interface Sprite2DLayer {
    readonly _entityType: "sprite-2d-layer";
    readonly atlas: SpriteAtlas;
    blendMode: SpriteBlendMode;
    pixelSnap: boolean;
    opacity: number;
    visible: boolean;
    order: number;
    alphaCutoff: number;
    view: Sprite2DView;
    count: number;

    /** @internal flat instance storage. */
    readonly _storage: SpriteStorage;
    /** @internal per-slot CPU-only metadata (matches storage.count). */
    readonly _meta: Sprite2DSlotMeta[];
    /** @internal sparse: index → animation state. */
    readonly _clips: Map<number, SpriteClipState>;
    /** @internal deferred renderable build (set by addToScene2D / addToScene). */
    _deferredBuild?: (engine: EngineContextInternal) => Promise<{ renderable: Renderable; updater: SceneUniformUpdater | null; dispose: () => void }>;
}

export function createSprite2DLayer(atlas: SpriteAtlas, opts: Sprite2DLayerOptions = {}): Sprite2DLayer {
    const layer: Sprite2DLayer = {
        _entityType: "sprite-2d-layer",
        atlas,
        blendMode: opts.blendMode ?? "alpha",
        pixelSnap: opts.pixelSnap ?? false,
        opacity: opts.opacity ?? 1,
        visible: opts.visible ?? true,
        order: opts.order ?? 0,
        alphaCutoff: opts.alphaCutoff ?? 0.5,
        view: {
            positionPx: opts.view?.positionPx ?? [0, 0],
            zoom: opts.view?.zoom ?? 1,
            rotation: opts.view?.rotation ?? 0,
        },
        count: 0,
        _storage: createSpriteStorage(opts.capacity ?? 64, SPRITE_2D_STRIDE),
        _meta: [],
        _clips: new Map(),
    };
    return layer;
}

function packSlot(layer: Sprite2DLayer, index: number, init: Sprite2DInit, frameIndex: number): void {
    const atlas = layer.atlas;
    const frame = atlas.frames[frameIndex]!;
    const sizePx = init.sizePx ?? frame.sourceSizePx;
    const pivot = init.pivot ?? frame.pivot;
    const rotation = init.rotation ?? 0;
    const visible = init.visible !== false;
    const sin = Math.sin(rotation);
    const cos = Math.cos(rotation);
    const color = init.color ?? [1, 1, 1, 1];
    const layerZ = Math.max(0, Math.min(1, init.layer ?? 0));
    const flipX = init.flipX === true ? 1 : 0;
    const flipY = init.flipY === true ? 1 : 0;
    const out = visible ? sizePx : [0, 0];
    const off = index * SPRITE_2D_STRIDE;
    const d = layer._storage.data;
    d[off + 0] = init.positionPx[0];
    d[off + 1] = init.positionPx[1];
    d[off + 2] = out[0]!;
    d[off + 3] = out[1]!;
    d[off + 4] = pivot[0];
    d[off + 5] = pivot[1];
    d[off + 6] = sin;
    d[off + 7] = cos;
    d[off + 8] = frame.uvMin[0];
    d[off + 9] = frame.uvMin[1];
    d[off + 10] = frame.uvMax[0];
    d[off + 11] = frame.uvMax[1];
    d[off + 12] = color[0]!;
    d[off + 13] = color[1]!;
    d[off + 14] = color[2]!;
    d[off + 15] = color[3]!;
    d[off + 16] = layerZ;
    d[off + 17] = flipX;
    d[off + 18] = flipY;
    d[off + 19] = 0;

    layer._meta[index] = {
        pickable: init.pickable !== false,
        visible,
        sizePx: [sizePx[0]!, sizePx[1]!],
        pivot: [pivot[0]!, pivot[1]!],
        rotation,
        frameIndex,
    };
}

export function addSprite2D(layer: Sprite2DLayer, sprite: Sprite2DInit): number {
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
    return index;
}

export function updateSprite2D(layer: Sprite2DLayer, index: number, patch: Partial<Sprite2DInit>): void {
    const meta = layer._meta[index]!;
    const off = index * SPRITE_2D_STRIDE;
    const d = layer._storage.data;
    // Reconstruct an init that merges patch over existing slot data.
    const merged: Sprite2DInit = {
        positionPx: patch.positionPx ?? [d[off + 0]!, d[off + 1]!],
        sizePx: patch.sizePx ?? meta.sizePx,
        pivot: patch.pivot ?? meta.pivot,
        rotation: patch.rotation ?? meta.rotation,
        color: patch.color ?? [d[off + 12]!, d[off + 13]!, d[off + 14]!, d[off + 15]!],
        flipX: patch.flipX ?? d[off + 17]! > 0.5,
        flipY: patch.flipY ?? d[off + 18]! > 0.5,
        layer: patch.layer ?? d[off + 16],
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
}

export function removeSprite2D(layer: Sprite2DLayer, index: number): void {
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
}

export function setSprite2DFrame(layer: Sprite2DLayer, index: number, frame: SpriteFrameRef): void {
    const frameIndex = resolveSpriteFrame(layer.atlas, frame);
    const meta = layer._meta[index]!;
    if (meta.frameIndex === frameIndex) {
        return;
    }
    meta.frameIndex = frameIndex;
    const f = layer.atlas.frames[frameIndex]!;
    const off = index * SPRITE_2D_STRIDE;
    const d = layer._storage.data;
    d[off + 8] = f.uvMin[0];
    d[off + 9] = f.uvMin[1];
    d[off + 10] = f.uvMax[0];
    d[off + 11] = f.uvMax[1];
    markDirty(layer._storage, index, index + 1);
}

export function playSprite2DClip(layer: Sprite2DLayer, index: number, clip: string, loop?: boolean): void {
    const clipIndex = layer.atlas._clipByName.get(clip);
    if (clipIndex === undefined) {
        throw new Error(`Sprite clip '${clip}' not found in atlas`);
    }
    const state = createSpriteClipState({ clipIndex, loopOverride: loop ?? null });
    layer._clips.set(index, state);
}

export function stopSprite2DClip(layer: Sprite2DLayer, index: number): void {
    const s = layer._clips.get(index);
    if (s) {
        s.playing = false;
    }
}

/** @internal Advance all active clips by `deltaMs` and update frame UVs. Called per frame. */
export function _tickSprite2DClips(layer: Sprite2DLayer, deltaMs: number): void {
    if (layer._clips.size === 0) {
        return;
    }
    for (const [index, state] of layer._clips) {
        const newFrame = advanceSpriteClip(layer.atlas, state, deltaMs);
        setSprite2DFrame(layer, index, newFrame);
    }
}
