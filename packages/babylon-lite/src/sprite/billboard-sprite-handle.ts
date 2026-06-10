/** Optional stable-identity Handle API for BillboardSpriteSystem. */
import { U32 } from "../engine/typed-arrays.js";
import type { BillboardIndexHandleHooks, BillboardSpriteInit, BillboardSpriteSystem } from "./billboard-sprite.js";
import { addBillboardSpriteIndex, removeBillboardSpriteIndex, setBillboardSpriteFrameIndex, updateBillboardSpriteIndex } from "./billboard-sprite.js";

/** Stable identity for a single billboard sprite that survives swap-remove reindexing. */
export interface BillboardSpriteHandle {
    /** @internal */
    readonly _entityType: "billboard-sprite-handle";
    readonly system: BillboardSpriteSystem;
    readonly id: number;
}

interface BillboardHandleState {
    nextId: number;
    idToIndex: Map<number, number>;
    indexToId: Uint32Array;
}

interface BillboardSystemWithHandles extends BillboardSpriteSystem {
    _handleState?: BillboardHandleState;
}

const MAX_HANDLE_ID = 0xffffffff;

function getOrCreateState(system: BillboardSpriteSystem): BillboardHandleState {
    const withHandles = system as BillboardSystemWithHandles;
    let state = withHandles._handleState;
    if (state) {
        ensureIndexCapacity(system, state);
        return state;
    }

    state = {
        nextId: 1,
        idToIndex: new Map<number, number>(),
        indexToId: new U32(system._capacity),
    };
    const hooks: BillboardIndexHandleHooks = {
        removeIndex(index, last): void {
            onRemoveIndex(state!, index, last);
        },
        clear(): void {
            state!.idToIndex.clear();
            state!.indexToId.fill(0);
        },
    };
    withHandles._handleState = state;
    withHandles._handleHooks = hooks;
    return state;
}

function getState(system: BillboardSpriteSystem): BillboardHandleState | undefined {
    return (system as BillboardSystemWithHandles)._handleState;
}

function ensureIndexCapacity(system: BillboardSpriteSystem, state: BillboardHandleState): void {
    if (state.indexToId.length >= system._capacity) {
        return;
    }
    const next = new U32(system._capacity);
    next.set(state.indexToId);
    state.indexToId = next;
}

function onRemoveIndex(state: BillboardHandleState, index: number, last: number): void {
    const removedId = state.indexToId[index] ?? 0;
    const movedId = state.indexToId[last] ?? 0;
    if (removedId !== 0) {
        state.idToIndex.delete(removedId);
    }
    if (index !== last) {
        if (movedId !== 0) {
            state.idToIndex.set(movedId, index);
        }
        if (index < state.indexToId.length) {
            state.indexToId[index] = movedId;
        }
    } else if (index < state.indexToId.length) {
        state.indexToId[index] = 0;
    }
    if (last < state.indexToId.length) {
        state.indexToId[last] = 0;
    }
}

function allocateId(state: BillboardHandleState): number {
    const id = state.nextId;
    if (id > MAX_HANDLE_ID) {
        throw new Error("addBillboardSprite: handle id space exhausted.");
    }
    state.nextId = id + 1;
    return id;
}

function lookupIndex(handle: BillboardSpriteHandle): number | null {
    const state = getState(handle.system);
    if (!state) {
        return null;
    }
    const index = state.idToIndex.get(handle.id);
    return index === undefined ? null : index;
}

function requireIndex(handle: BillboardSpriteHandle, caller: string): number {
    const index = lookupIndex(handle);
    if (index === null) {
        throw new Error(`${caller}: BillboardSpriteHandle ${handle.id} has been removed.`);
    }
    return index;
}

/**
 * Adds a billboard sprite to the system and returns a stable handle to it.
 * @param system - Billboard system to add the sprite to.
 * @param init - Initial sprite properties.
 * @returns A handle that stays valid as sprites are added and removed.
 */
export function addBillboardSprite(system: BillboardSpriteSystem, init: BillboardSpriteInit): BillboardSpriteHandle {
    const index = addBillboardSpriteIndex(system, init);
    const state = getOrCreateState(system);
    const id = allocateId(state);
    state.idToIndex.set(id, index);
    state.indexToId[index] = id;
    return { _entityType: "billboard-sprite-handle", system, id };
}

/**
 * Updates the properties of the billboard sprite referenced by `handle`.
 * @param handle - Handle of the sprite to update.
 * @param patch - Partial set of properties to overwrite.
 * @throws If the handle has already been removed.
 */
export function updateBillboardSprite(handle: BillboardSpriteHandle, patch: Partial<BillboardSpriteInit>): void {
    updateBillboardSpriteIndex(handle.system, requireIndex(handle, "updateBillboardSprite"), patch);
}

/**
 * Removes the billboard sprite referenced by `handle`. Does nothing if it is already gone.
 * @param handle - Handle of the sprite to remove.
 */
export function removeBillboardSprite(handle: BillboardSpriteHandle): void {
    const index = lookupIndex(handle);
    if (index === null) {
        return;
    }
    removeBillboardSpriteIndex(handle.system, index);
}

/**
 * Sets the atlas frame of the billboard sprite referenced by `handle`, preserving its world size and flip state.
 * @param handle - Handle of the sprite to update.
 * @param frame - Atlas frame index.
 * @throws If the handle has already been removed.
 */
export function setBillboardSpriteFrame(handle: BillboardSpriteHandle, frame: number): void {
    setBillboardSpriteFrameIndex(handle.system, requireIndex(handle, "setBillboardSpriteFrame"), frame);
}

/**
 * Resolves the current instance index of the sprite referenced by `handle`.
 * @param handle - Handle of the sprite to resolve.
 * @returns The current instance index in the system's buffers.
 * @throws If the handle has already been removed.
 */
export function getBillboardSpriteHandleIndex(handle: BillboardSpriteHandle): number {
    return requireIndex(handle, "getBillboardSpriteHandleIndex");
}

/**
 * Returns `true` if the sprite referenced by `handle` is still present in its system.
 * @param handle - Handle to test.
 */
export function isBillboardSpriteHandleAlive(handle: BillboardSpriteHandle): boolean {
    return lookupIndex(handle) !== null;
}
