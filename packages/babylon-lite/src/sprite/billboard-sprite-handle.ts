/** Optional stable-identity Handle API for BillboardSpriteSystem. */
import type { BillboardIndexHandleHooks, BillboardSpriteInit, BillboardSpriteSystem } from "./billboard-sprite.js";
import { addBillboardSpriteIndex, removeBillboardSpriteIndex, setBillboardSpriteFrameIndex, updateBillboardSpriteIndex } from "./billboard-sprite.js";

export interface BillboardSpriteHandle {
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
        indexToId: new Uint32Array(system._capacity),
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
    const next = new Uint32Array(system._capacity);
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

export function addBillboardSprite(system: BillboardSpriteSystem, init: BillboardSpriteInit): BillboardSpriteHandle {
    const index = addBillboardSpriteIndex(system, init);
    const state = getOrCreateState(system);
    const id = allocateId(state);
    state.idToIndex.set(id, index);
    state.indexToId[index] = id;
    return { _entityType: "billboard-sprite-handle", system, id };
}

export function updateBillboardSprite(handle: BillboardSpriteHandle, patch: Partial<BillboardSpriteInit>): void {
    updateBillboardSpriteIndex(handle.system, requireIndex(handle, "updateBillboardSprite"), patch);
}

export function removeBillboardSprite(handle: BillboardSpriteHandle): void {
    const index = lookupIndex(handle);
    if (index === null) {
        return;
    }
    removeBillboardSpriteIndex(handle.system, index);
}

export function setBillboardSpriteFrame(handle: BillboardSpriteHandle, frame: number): void {
    setBillboardSpriteFrameIndex(handle.system, requireIndex(handle, "setBillboardSpriteFrame"), frame);
}

export function getBillboardSpriteHandleIndex(handle: BillboardSpriteHandle): number {
    return requireIndex(handle, "getBillboardSpriteHandleIndex");
}

export function isBillboardSpriteHandleAlive(handle: BillboardSpriteHandle): boolean {
    return lookupIndex(handle) !== null;
}
