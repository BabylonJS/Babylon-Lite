/**
 * Billboard sprites: world-space quads backed by a SpriteAtlas.
 *
 * This module is pure state + standalone index API. The optional Handle API
 * lives in `billboard-sprite-handle.ts` and installs swap-remove hooks lazily.
 */
import type { SpriteAtlas } from "./shared/sprite-atlas.js";
import { resolveSpriteFrame } from "./shared/sprite-atlas.js";
import type { SpriteBlendMode } from "./sprite-2d.js";

export type BillboardBlendMode = Extract<SpriteBlendMode, "alpha" | "premultiplied" | "cutout">;

export interface BillboardSpriteSystemOptions {
    capacity?: number;
    blendMode?: BillboardBlendMode;
    alphaCutoff?: number;
    opacity?: number;
    visible?: boolean;
    order?: number;
}

export type BillboardOrientation = "facing" | "axis-locked";
export type BillboardDepthMode = "transparent" | "cutout";

export interface BillboardSpriteSystem<TOrientation extends BillboardOrientation = BillboardOrientation> {
    readonly _entityType: "billboard-sprite-system";
    readonly atlas: SpriteAtlas;
    readonly blendMode: BillboardBlendMode;
    alphaCutoff: number;
    opacity: number;
    visible: boolean;
    readonly order: number;
    readonly count: number;

    /** @internal Orientation shader path for this system. */
    readonly _orientation: TOrientation;
    /** @internal Depth/blend pipeline path for this system. */
    readonly _depthMode: BillboardDepthMode;
    /** @internal Normalized lock axis for axis-locked systems; zero for facing. */
    readonly _axis: readonly [number, number, number];
    /** @internal Capacity of the per-instance buffer in sprites. */
    _capacity: number;
    /** @internal Per-instance stride in floats. */
    readonly _instanceFloatsPerSprite: number;
    /** @internal Per-instance stride in bytes. */
    readonly _instanceStrideBytes: number;
    /** @internal Billboard instance data. */
    _instanceData: Float32Array;
    /** @internal True size shadow, unaffected by `visible: false`. */
    _savedSize: Float32Array;
    /** @internal Bumped on any instance edit. */
    _version: number;
    /** @internal Dirty min index inclusive. */
    _dirtyMin: number;
    /** @internal Dirty max index exclusive. */
    _dirtyMax: number;
    /** @internal Optional hooks installed by the opt-in handle module. */
    _handleHooks?: BillboardIndexHandleHooks;
}

/** @internal Lazy hooks used by the opt-in Handle API to track swap-removes. */
export interface BillboardIndexHandleHooks {
    readonly removeIndex: (index: number, last: number) => void;
    readonly clear: () => void;
}

export type FacingBillboardSpriteSystem = BillboardSpriteSystem<"facing">;
export type AxisLockedBillboardSpriteSystem = BillboardSpriteSystem<"axis-locked">;

export interface BillboardSpriteInit {
    position: [number, number, number];
    sizeWorld: [number, number];
    frame?: number;
    rotation?: number;
    pivot?: [number, number];
    color?: [number, number, number, number];
    flipX?: boolean;
    flipY?: boolean;
    visible?: boolean;
}

export const BILLBOARD_INSTANCE_FLOATS_PER_SPRITE = 16;
export const BILLBOARD_INSTANCE_STRIDE_BYTES = BILLBOARD_INSTANCE_FLOATS_PER_SPRITE * 4;
export const BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE = 2;

const DEFAULT_CAPACITY = 16;

function setBillboardCount(system: BillboardSpriteSystem, count: number): void {
    (system as { count: number }).count = count;
}

function resolveAlphaCutoff(opts: BillboardSpriteSystemOptions, depthMode: BillboardDepthMode): number {
    const cutoff = opts.alphaCutoff ?? (depthMode === "cutout" ? 0.5 : 0);
    if (!Number.isFinite(cutoff)) {
        throw new Error("BillboardSpriteSystem: alphaCutoff must be a finite number.");
    }
    return cutoff;
}

function resolveOpacity(opts: BillboardSpriteSystemOptions): number {
    const opacity = opts.opacity ?? 1;
    if (!Number.isFinite(opacity)) {
        throw new Error("BillboardSpriteSystem: opacity must be a finite number.");
    }
    return opacity;
}

function resolveBillboardDepthMode(blendMode: BillboardBlendMode): BillboardDepthMode {
    return blendMode === "cutout" ? "cutout" : "transparent";
}

export function createFacingBillboardSystem(atlas: SpriteAtlas, opts: BillboardSpriteSystemOptions = {}): FacingBillboardSpriteSystem {
    return createBillboardSystem(atlas, "facing", [0, 0, 0], opts);
}

export function createAxisLockedBillboardSystem(
    atlas: SpriteAtlas,
    axis: readonly [number, number, number],
    opts: BillboardSpriteSystemOptions = {}
): AxisLockedBillboardSpriteSystem {
    if (!Number.isFinite(axis[0]) || !Number.isFinite(axis[1]) || !Number.isFinite(axis[2])) {
        throw new Error("createAxisLockedBillboardSystem: axis components must be finite numbers.");
    }
    const lengthSq = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
    if (lengthSq < 1e-8) {
        throw new Error("createAxisLockedBillboardSystem: axis must be non-zero.");
    }
    const invLength = 1 / Math.sqrt(lengthSq);
    const normalized: [number, number, number] = [axis[0] * invLength, axis[1] * invLength, axis[2] * invLength];
    return createBillboardSystem(atlas, "axis-locked", normalized, opts);
}

function createBillboardSystem<TOrientation extends BillboardOrientation>(
    atlas: SpriteAtlas,
    orientation: TOrientation,
    axis: readonly [number, number, number],
    opts: BillboardSpriteSystemOptions
): BillboardSpriteSystem<TOrientation> {
    const blendMode = opts.blendMode ?? "alpha";
    const depthMode = resolveBillboardDepthMode(blendMode);
    const capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    const instanceData = new Float32Array(capacity * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE);
    return {
        _entityType: "billboard-sprite-system",
        atlas,
        blendMode,
        alphaCutoff: resolveAlphaCutoff(opts, depthMode),
        opacity: resolveOpacity(opts),
        visible: opts.visible ?? true,
        order: opts.order ?? (depthMode === "transparent" ? 200 : 100),
        count: 0,
        _orientation: orientation,
        _depthMode: depthMode,
        _axis: axis,
        _capacity: capacity,
        _instanceFloatsPerSprite: BILLBOARD_INSTANCE_FLOATS_PER_SPRITE,
        _instanceStrideBytes: BILLBOARD_INSTANCE_STRIDE_BYTES,
        _instanceData: instanceData,
        _savedSize: new Float32Array(capacity * BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE),
        _version: 0,
        _dirtyMin: 0,
        _dirtyMax: 0,
    };
}

function growCapacity(system: BillboardSpriteSystem, minCapacity: number): void {
    let capacity = system._capacity;
    while (capacity < minCapacity) {
        capacity *= 2;
    }
    const next = new Float32Array(capacity * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE);
    next.set(system._instanceData);
    system._instanceData = next;
    const nextSavedSize = new Float32Array(capacity * BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE);
    nextSavedSize.set(system._savedSize);
    system._savedSize = nextSavedSize;
    system._capacity = capacity;
}

function writeInstance(system: BillboardSpriteSystem, slotIndex: number, props: Partial<BillboardSpriteInit>, prev: Float32Array | null): void {
    const data = system._instanceData;
    const base = slotIndex * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE;
    const savedBase = slotIndex * BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE;
    const isAdd = prev === null;
    const frame = props.frame !== undefined ? system.atlas.frames[resolveSpriteFrame(system.atlas, props.frame)]! : null;

    const posX = props.position ? props.position[0] : prev![0]!;
    const posY = props.position ? props.position[1] : prev![1]!;
    const posZ = props.position ? props.position[2] : prev![2]!;

    let trueWidth: number;
    let trueHeight: number;
    if (props.sizeWorld) {
        trueWidth = props.sizeWorld[0];
        trueHeight = props.sizeWorld[1];
    } else if (isAdd) {
        trueWidth = 0;
        trueHeight = 0;
    } else {
        trueWidth = system._savedSize[savedBase]!;
        trueHeight = system._savedSize[savedBase + 1]!;
    }
    system._savedSize[savedBase] = trueWidth;
    system._savedSize[savedBase + 1] = trueHeight;

    let visible: boolean;
    if (props.visible !== undefined) {
        visible = props.visible;
    } else if (isAdd) {
        visible = true;
    } else {
        visible = prev![3]! !== 0 || prev![4]! !== 0;
    }

    let uvMinX: number;
    let uvMinY: number;
    let uvMaxX: number;
    let uvMaxY: number;
    if (frame) {
        uvMinX = frame.uvMin[0];
        uvMinY = frame.uvMin[1];
        uvMaxX = frame.uvMax[0];
        uvMaxY = frame.uvMax[1];
    } else if (isAdd) {
        uvMinX = 0;
        uvMinY = 0;
        uvMaxX = 1;
        uvMaxY = 1;
    } else {
        uvMinX = prev![5]!;
        uvMinY = prev![6]!;
        uvMaxX = prev![7]!;
        uvMaxY = prev![8]!;
    }
    const wantsFlipX = props.flipX ?? (!isAdd && prev![5]! > prev![7]!);
    const wantsFlipY = props.flipY ?? (!isAdd && prev![6]! > prev![8]!);
    if (uvMinX > uvMaxX !== wantsFlipX) {
        const previousMinX = uvMinX;
        uvMinX = uvMaxX;
        uvMaxX = previousMinX;
    }
    if (uvMinY > uvMaxY !== wantsFlipY) {
        const previousMinY = uvMinY;
        uvMinY = uvMaxY;
        uvMaxY = previousMinY;
    }

    const rotation = props.rotation ?? (prev ? prev[9]! : 0);
    const pivotX = props.pivot ? props.pivot[0] : prev ? prev[10]! : (frame?.pivot[0] ?? 0.5);
    const pivotY = props.pivot ? props.pivot[1] : prev ? prev[11]! : (frame?.pivot[1] ?? 0.5);

    data[base + 0] = posX;
    data[base + 1] = posY;
    data[base + 2] = posZ;
    data[base + 3] = visible ? trueWidth : 0;
    data[base + 4] = visible ? trueHeight : 0;
    data[base + 5] = uvMinX;
    data[base + 6] = uvMinY;
    data[base + 7] = uvMaxX;
    data[base + 8] = uvMaxY;
    data[base + 9] = rotation;
    data[base + 10] = pivotX;
    data[base + 11] = pivotY;
    if (props.color) {
        data[base + 12] = props.color[0];
        data[base + 13] = props.color[1];
        data[base + 14] = props.color[2];
        data[base + 15] = props.color[3];
    } else if (isAdd) {
        data[base + 12] = 1;
        data[base + 13] = 1;
        data[base + 14] = 1;
        data[base + 15] = 1;
    }
}

function markDirty(system: BillboardSpriteSystem, dirtyMin: number, dirtyMax: number): void {
    if (system._dirtyMin >= system._dirtyMax) {
        system._dirtyMin = dirtyMin;
        system._dirtyMax = dirtyMax;
    } else {
        if (dirtyMin < system._dirtyMin) {
            system._dirtyMin = dirtyMin;
        }
        if (dirtyMax > system._dirtyMax) {
            system._dirtyMax = dirtyMax;
        }
    }
    system._version = (system._version + 1) | 0;
}

export function addBillboardSpriteIndex(system: BillboardSpriteSystem, props: BillboardSpriteInit): number {
    if (props.position === undefined) {
        throw new Error("addBillboardSpriteIndex: props.position is required.");
    }
    if (props.sizeWorld === undefined) {
        throw new Error("addBillboardSpriteIndex: props.sizeWorld is required.");
    }
    const index = system.count;
    if (index >= system._capacity) {
        growCapacity(system, index + 1);
    }
    writeInstance(system, index, props, null);
    setBillboardCount(system, system.count + 1);
    markDirty(system, index, index + 1);
    return index;
}

export function updateBillboardSpriteIndex(system: BillboardSpriteSystem, index: number, patch: Partial<BillboardSpriteInit>): void {
    if (index < 0 || index >= system.count) {
        throw new Error(`updateBillboardSpriteIndex: index ${index} out of range [0, ${system.count})`);
    }
    const base = index * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE;
    const prev = system._instanceData.subarray(base, base + BILLBOARD_INSTANCE_FLOATS_PER_SPRITE);
    writeInstance(system, index, patch, prev);
    markDirty(system, index, index + 1);
}

export function removeBillboardSpriteIndex(system: BillboardSpriteSystem, index: number): void {
    if (index < 0 || index >= system.count) {
        throw new Error(`removeBillboardSpriteIndex: index ${index} out of range [0, ${system.count})`);
    }
    const last = system.count - 1;
    system._handleHooks?.removeIndex(index, last);
    if (index !== last) {
        system._instanceData.copyWithin(
            index * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE,
            last * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE,
            (last + 1) * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE
        );
        system._savedSize.copyWithin(
            index * BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE,
            last * BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE,
            (last + 1) * BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE
        );
    }
    system._savedSize[last * BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE] = 0;
    system._savedSize[last * BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE + 1] = 0;
    setBillboardCount(system, last);
    markDirty(system, index, index + 1);
}

export function clearBillboardSprites(system: BillboardSpriteSystem): void {
    const count = system.count;
    system._dirtyMin = 0;
    system._dirtyMax = 0;
    system._handleHooks?.clear();
    if (count === 0) {
        return;
    }
    system._savedSize.fill(0, 0, count * BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE);
    setBillboardCount(system, 0);
    system._version = (system._version + 1) | 0;
}

export function setBillboardSpriteFrameIndex(system: BillboardSpriteSystem, index: number, frame: number): void {
    if (index < 0 || index >= system.count) {
        throw new Error(`setBillboardSpriteFrameIndex: index ${index} out of range [0, ${system.count})`);
    }
    const frameIndex = resolveSpriteFrame(system.atlas, frame);
    const spriteFrame = system.atlas.frames[frameIndex]!;
    const base = index * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE;
    const flipX = system._instanceData[base + 5]! > system._instanceData[base + 7]!;
    const flipY = system._instanceData[base + 6]! > system._instanceData[base + 8]!;
    system._instanceData[base + 5] = flipX ? spriteFrame.uvMax[0] : spriteFrame.uvMin[0];
    system._instanceData[base + 6] = flipY ? spriteFrame.uvMax[1] : spriteFrame.uvMin[1];
    system._instanceData[base + 7] = flipX ? spriteFrame.uvMin[0] : spriteFrame.uvMax[0];
    system._instanceData[base + 8] = flipY ? spriteFrame.uvMin[1] : spriteFrame.uvMax[1];
    markDirty(system, index, index + 1);
}
