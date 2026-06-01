/** Optional stable-identity Handle API for Sprite2DLayer. */
import type { Sprite2DIndexHandleHooks, Sprite2DLayer, Sprite2DProps } from "./sprite-2d.js";
import { addSprite2DIndex, removeSprite2DIndex, setSprite2DFrameIndex, updateSprite2DIndex } from "./sprite-2d.js";

/** Stable identity for a single 2D sprite that survives swap-remove reindexing. */
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

/**
 * Adds a sprite to the layer and returns a stable handle to it.
 * @param layer - Sprite layer to add the sprite to.
 * @param props - Initial sprite properties.
 * @returns A handle that stays valid as sprites are added and removed.
 */
export function addSprite2D(layer: Sprite2DLayer, props: Sprite2DProps): Sprite2DHandle {
    const index = addSprite2DIndex(layer, props);
    const state = getOrCreateState(layer);
    const id = allocateId(state);
    state.idToIndex.set(id, index);
    state.indexToId[index] = id;
    return { _entityType: "sprite-2d-handle", layer, id };
}

/**
 * Updates the properties of the sprite referenced by `handle`.
 * @param handle - Handle of the sprite to update.
 * @param patch - Partial set of properties to overwrite.
 * @throws If the handle has already been removed.
 */
export function updateSprite2D(handle: Sprite2DHandle, patch: Partial<Sprite2DProps>): void {
    updateSprite2DIndex(handle.layer, requireIndex(handle, "updateSprite2D"), patch);
}

/**
 * Removes the sprite referenced by `handle`. Does nothing if it is already gone.
 * @param handle - Handle of the sprite to remove.
 */
export function removeSprite2D(handle: Sprite2DHandle): void {
    const index = lookupIndex(handle);
    if (index === null) {
        return;
    }
    removeSprite2DIndex(handle.layer, index);
}

/**
 * Sets the atlas frame of the sprite referenced by `handle`.
 * @param handle - Handle of the sprite to update.
 * @param frame - Atlas frame index.
 * @throws If the handle has already been removed.
 */
export function setSprite2DFrame(handle: Sprite2DHandle, frame: number): void {
    setSprite2DFrameIndex(handle.layer, requireIndex(handle, "setSprite2DFrame"), frame);
}

/**
 * Resolves the current instance index of the sprite referenced by `handle`.
 * @param handle - Handle of the sprite to resolve.
 * @returns The current instance index in the layer's buffers.
 * @throws If the handle has already been removed.
 */
export function getSprite2DHandleIndex(handle: Sprite2DHandle): number {
    return requireIndex(handle, "getSprite2DHandleIndex");
}

/**
 * Returns `true` if the sprite referenced by `handle` is still present in its layer.
 * @param handle - Handle to test.
 */
export function isSprite2DHandleAlive(handle: Sprite2DHandle): boolean {
    return lookupIndex(handle) !== null;
}
