/** Optional stable-identity Handle API for Sprite2DLayer. */
import type { Sprite2DIndexHandleHooks, Sprite2DLayer, Sprite2DProps } from "./sprite-2d.js";
import { addSprite2DIndex, removeSprite2DIndex, setSprite2DFrameIndex, updateSprite2DIndex } from "./sprite-2d.js";

export interface Sprite2DHandle {
    readonly _entityType: "sprite-2d-handle";
    readonly layer: Sprite2DLayer;
    readonly id: number;
}

interface Sprite2DHandleState {
    nextId: number;
    idToIndex: Map<number, number>;
    indexToId: Uint32Array;
}

interface Sprite2DLayerWithHandles extends Sprite2DLayer {
    _handleState?: Sprite2DHandleState;
}

const MAX_HANDLE_ID = 0xffffffff;

function getOrCreateState(layer: Sprite2DLayer): Sprite2DHandleState {
    const withHandles = layer as Sprite2DLayerWithHandles;
    let state = withHandles._handleState;
    if (state) {
        ensureIndexCapacity(layer, state);
        return state;
    }

    state = {
        nextId: 1,
        idToIndex: new Map<number, number>(),
        indexToId: new Uint32Array(layer._capacity),
    };
    const hooks: Sprite2DIndexHandleHooks = {
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

function getState(layer: Sprite2DLayer): Sprite2DHandleState | undefined {
    return (layer as Sprite2DLayerWithHandles)._handleState;
}

function ensureIndexCapacity(layer: Sprite2DLayer, state: Sprite2DHandleState): void {
    if (state.indexToId.length >= layer._capacity) {
        return;
    }
    const next = new Uint32Array(layer._capacity);
    next.set(state.indexToId);
    state.indexToId = next;
}

function onRemoveIndex(state: Sprite2DHandleState, index: number, last: number): void {
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

function allocateId(state: Sprite2DHandleState): number {
    const id = state.nextId;
    if (id > MAX_HANDLE_ID) {
        throw new Error("addSprite2D: handle id space exhausted.");
    }
    state.nextId = id + 1;
    return id;
}

function lookupIndex(handle: Sprite2DHandle): number | null {
    const state = getState(handle.layer);
    if (!state) {
        return null;
    }
    const index = state.idToIndex.get(handle.id);
    return index === undefined ? null : index;
}

function requireIndex(handle: Sprite2DHandle, caller: string): number {
    const index = lookupIndex(handle);
    if (index === null) {
        throw new Error(`${caller}: Sprite2DHandle ${handle.id} has been removed.`);
    }
    return index;
}

export function addSprite2D(layer: Sprite2DLayer, props: Sprite2DProps): Sprite2DHandle {
    const index = addSprite2DIndex(layer, props);
    const state = getOrCreateState(layer);
    const id = allocateId(state);
    state.idToIndex.set(id, index);
    state.indexToId[index] = id;
    return { _entityType: "sprite-2d-handle", layer, id };
}

export function updateSprite2D(handle: Sprite2DHandle, patch: Partial<Sprite2DProps>): void {
    updateSprite2DIndex(handle.layer, requireIndex(handle, "updateSprite2D"), patch);
}

export function removeSprite2D(handle: Sprite2DHandle): void {
    const index = lookupIndex(handle);
    if (index === null) {
        return;
    }
    removeSprite2DIndex(handle.layer, index);
}

export function setSprite2DFrame(handle: Sprite2DHandle, frame: number): void {
    setSprite2DFrameIndex(handle.layer, requireIndex(handle, "setSprite2DFrame"), frame);
}

export function getSprite2DHandleIndex(handle: Sprite2DHandle): number {
    return requireIndex(handle, "getSprite2DHandleIndex");
}

export function isSprite2DHandleAlive(handle: Sprite2DHandle): boolean {
    return lookupIndex(handle) !== null;
}
