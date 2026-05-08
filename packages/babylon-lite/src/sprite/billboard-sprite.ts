/**
 * Facing billboard sprites: world-space, camera-facing quads backed by a SpriteAtlas.
 *
 * This module is pure state + standalone index API only. Scene integration lives in
 * `billboard-scene.ts` so 2D sprite paths and mesh-only scenes do not import the
 * billboard renderable/pipeline graph unless they explicitly opt in.
 */
import type { SpriteAtlas } from "./shared/sprite-atlas.js";
import { resolveSpriteFrame } from "./shared/sprite-atlas.js";
import type { SpriteBlendMode } from "./sprite-2d.js";

export interface BillboardSpriteSystemOptions {
    capacity?: number;
    blendMode?: SpriteBlendMode;
    opacity?: number;
    visible?: boolean;
    order?: number;
}

export interface BillboardSpriteSystem {
    readonly _entityType: "facing-billboard-sprite-system";
    readonly atlas: SpriteAtlas;
    readonly blendMode: SpriteBlendMode;
    opacity: number;
    visible: boolean;
    order: number;
    count: number;

    /** @internal Capacity of the per-instance buffer in sprites. */
    _capacity: number;
    /** @internal Per-instance stride in floats. */
    readonly _instanceFloatsPerSprite: number;
    /** @internal Per-instance stride in bytes. */
    readonly _instanceStrideBytes: number;
    /** @internal Packed billboard instance data. */
    _instanceData: Float32Array;
    /** @internal Uint32 alias used for packed unorm8x4 color writes. */
    _instanceDataU32: Uint32Array;
    /** @internal True size shadow, unaffected by `visible: false`. */
    _savedSize: Float32Array;
    /** @internal Bumped on any instance edit. */
    _version: number;
    /** @internal Dirty min index inclusive. */
    _dirtyMin: number;
    /** @internal Dirty max index exclusive. */
    _dirtyMax: number;
}

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

export const BILLBOARD_INSTANCE_FLOATS_PER_SPRITE = 13;
export const BILLBOARD_INSTANCE_STRIDE_BYTES = BILLBOARD_INSTANCE_FLOATS_PER_SPRITE * 4;
export const BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE = 2;

const DEFAULT_CAPACITY = 16;

function assertBlendSupported(blendMode: SpriteBlendMode): void {
    if (blendMode === "additive" || blendMode === "multiply" || blendMode === "cutout") {
        throw new Error(`FacingBillboardSpriteSystem: blendMode: "${blendMode}" lands in a later PR. Use "alpha" or "premultiplied".`);
    }
}

export function createFacingBillboardSystem(atlas: SpriteAtlas, opts: BillboardSpriteSystemOptions = {}): BillboardSpriteSystem {
    const blendMode = opts.blendMode ?? "alpha";
    assertBlendSupported(blendMode);
    const capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    const instanceData = new Float32Array(capacity * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE);
    return {
        _entityType: "facing-billboard-sprite-system",
        atlas,
        blendMode,
        opacity: opts.opacity ?? 1,
        visible: opts.visible ?? true,
        order: opts.order ?? 200,
        count: 0,
        _capacity: capacity,
        _instanceFloatsPerSprite: BILLBOARD_INSTANCE_FLOATS_PER_SPRITE,
        _instanceStrideBytes: BILLBOARD_INSTANCE_STRIDE_BYTES,
        _instanceData: instanceData,
        _instanceDataU32: new Uint32Array(instanceData.buffer),
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
    system._instanceDataU32 = new Uint32Array(next.buffer);
    const nextSavedSize = new Float32Array(capacity * BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE);
    nextSavedSize.set(system._savedSize);
    system._savedSize = nextSavedSize;
    system._capacity = capacity;
}

function packColor(red: number, green: number, blue: number, alpha: number): number {
    const redByte = Math.max(0, Math.min(255, Math.round(red * 255)));
    const greenByte = Math.max(0, Math.min(255, Math.round(green * 255)));
    const blueByte = Math.max(0, Math.min(255, Math.round(blue * 255)));
    const alphaByte = Math.max(0, Math.min(255, Math.round(alpha * 255)));
    return (redByte | (greenByte << 8) | (blueByte << 16) | (alphaByte << 24)) >>> 0;
}

function writeInstance(system: BillboardSpriteSystem, slotIndex: number, props: Partial<BillboardSpriteInit>, prev: Float32Array | null): void {
    const data = system._instanceData;
    const dataU32 = system._instanceDataU32;
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
        dataU32[base + 12] = packColor(props.color[0], props.color[1], props.color[2], props.color[3]);
    } else if (isAdd) {
        dataU32[base + 12] = 0xffffffff;
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
    system.count++;
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
    markDirty(system, index, index + 1);
    system.count--;
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
