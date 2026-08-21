/** Optional stable Y-sort for the GPU representation of a pure Sprite2D layer. */
import { F32, F64, U32 } from "../engine/typed-arrays.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import { _markSprite2DDirty } from "./sprite-2d.js";
import type { Sprite2DYSortHook } from "./sprite-2d-y-sort-hook.js";
import { _registerSprite2DYSortHook } from "./sprite-2d-y-sort-hook.js";

/** Options validated on every enable call and applied when creating Y-sort state. */
export interface Sprite2DYSortOptions {
    /** Bias assigned to existing and newly inserted sprites until individually changed. Defaults to `0`. */
    defaultBias?: number;
}

/** Pure CPU state for an enabled Sprite2D Y-sort layer. */
export interface Sprite2DYSortState {
    /** Layer whose GPU representation is Y-sorted. */
    readonly layer: Sprite2DLayer;
    /** Bias assigned to existing and newly inserted sprites by default. */
    readonly defaultBias: number;
    /** Whether this state is currently installed on its layer. */
    readonly enabled: boolean;
    /** @internal Draw slot to logical slot. */
    _permutation: Uint32Array;
    /** @internal Logical slot to draw slot. */
    _inversePermutation: Uint32Array;
    /** @internal Stable merge-sort scratch. */
    _mergeScratch: Uint32Array;
    /** @internal Persistent insertion serial per logical slot. */
    _serials: Float64Array;
    /** @internal Per-logical-slot ordering bias. */
    _biases: Float64Array;
    /** @internal Cached `positionPx.y + bias` per logical slot. */
    _keys: Float64Array;
    /** @internal GPU-order packed instance records. */
    _packedInstances: Float32Array;
    /** @internal Capacity represented by the metadata arrays. */
    _capacity: number;
    /** @internal Instance-record float width represented by `_packedInstances`. */
    _packedStride: number;
    /** @internal Number of logical slots currently represented by metadata. */
    _activeCount: number;
    /** @internal Next persistent insertion serial. */
    _nextSerial: number;
    /** @internal Whether `_permutation` must be recomputed. */
    _sortDirty: boolean;
    /** @internal Whether the next upload must repack every active record. */
    _fullUpload: boolean;
    /** @internal Minimum dirty packed draw slot, inclusive. */
    _dirtyMin: number;
    /** @internal Maximum dirty packed draw slot, exclusive. */
    _dirtyMax: number;
}

function getState(layer: Sprite2DLayer): Sprite2DYSortState | undefined {
    return layer._ySortState;
}

function allocateSerial(state: Sprite2DYSortState): number {
    return state._nextSerial++;
}

function keyAt(layer: Sprite2DLayer, state: Sprite2DYSortState, index: number): number {
    return layer._instanceData[index * layer._instanceFloatsPerSprite + 1]! + state._biases[index]!;
}

function ensureStorage(layer: Sprite2DLayer, state: Sprite2DYSortState): void {
    const capacity = layer._capacity;
    if (capacity > state._capacity) {
        const permutation = new U32(capacity);
        permutation.set(state._permutation);
        state._permutation = permutation;
        const inversePermutation = new U32(capacity);
        inversePermutation.set(state._inversePermutation);
        state._inversePermutation = inversePermutation;
        const mergeScratch = new U32(capacity);
        mergeScratch.set(state._mergeScratch);
        state._mergeScratch = mergeScratch;
        const serials = new F64(capacity);
        serials.set(state._serials);
        state._serials = serials;
        const biases = new F64(capacity);
        biases.set(state._biases);
        state._biases = biases;
        const keys = new F64(capacity);
        keys.set(state._keys);
        state._keys = keys;
        state._capacity = capacity;
        state._sortDirty = true;
        state._fullUpload = true;
    }
    const stride = layer._instanceFloatsPerSprite;
    if (state._packedInstances.length < capacity * stride || state._packedStride !== stride) {
        state._packedInstances = new F32(capacity * stride);
        state._packedStride = stride;
        state._fullUpload = true;
    }
}

function syncCount(layer: Sprite2DLayer, state: Sprite2DYSortState): void {
    ensureStorage(layer, state);
    if (layer.count > state._activeCount) {
        for (let index = state._activeCount; index < layer.count; index++) {
            state._biases[index] = state.defaultBias;
            state._serials[index] = allocateSerial(state);
            state._keys[index] = keyAt(layer, state, index);
        }
        state._sortDirty = true;
        state._fullUpload = true;
    } else if (layer.count < state._activeCount) {
        state._serials.fill(0, layer.count, state._activeCount);
        state._biases.fill(0, layer.count, state._activeCount);
        state._keys.fill(0, layer.count, state._activeCount);
        state._sortDirty = true;
        state._fullUpload = true;
    }
    state._activeCount = layer.count;
}

function comesBefore(state: Sprite2DYSortState, left: number, right: number): boolean {
    const leftKey = state._keys[left]!;
    const rightKey = state._keys[right]!;
    if (leftKey < rightKey) {
        return true;
    }
    if (leftKey > rightKey) {
        return false;
    }
    return state._serials[left]! < state._serials[right]!;
}

function ensureSorted(layer: Sprite2DLayer, state: Sprite2DYSortState): void {
    syncCount(layer, state);
    if (!state._sortDirty) {
        return;
    }
    const count = layer.count;
    const permutation = state._permutation;
    for (let index = 0; index < count; index++) {
        permutation[index] = index;
    }
    let source = permutation;
    let target = state._mergeScratch;
    for (let width = 1; width < count; width *= 2) {
        for (let start = 0; start < count; start += width * 2) {
            const middle = Math.min(start + width, count);
            const end = Math.min(start + width * 2, count);
            let left = start;
            let right = middle;
            for (let output = start; output < end; output++) {
                if (left < middle && (right >= end || comesBefore(state, source[left]!, source[right]!))) {
                    target[output] = source[left++]!;
                } else {
                    target[output] = source[right++]!;
                }
            }
        }
        const previousSource = source;
        source = target;
        target = previousSource;
    }
    if (source !== permutation) {
        for (let index = 0; index < count; index++) {
            permutation[index] = source[index]!;
        }
    }
    for (let drawIndex = 0; drawIndex < count; drawIndex++) {
        state._inversePermutation[permutation[drawIndex]!] = drawIndex;
    }
    state._sortDirty = false;
}

function markPackedDirty(state: Sprite2DYSortState, drawIndex: number): void {
    if (state._dirtyMin >= state._dirtyMax) {
        state._dirtyMin = drawIndex;
        state._dirtyMax = drawIndex + 1;
    } else {
        state._dirtyMin = Math.min(state._dirtyMin, drawIndex);
        state._dirtyMax = Math.max(state._dirtyMax, drawIndex + 1);
    }
}

function observeDirty(layer: Sprite2DLayer, lo: number, hi: number): void {
    const state = getState(layer);
    if (!state) {
        return;
    }
    syncCount(layer, state);
    const end = Math.min(hi, layer.count);
    for (let index = Math.max(0, lo); index < end; index++) {
        const key = keyAt(layer, state, index);
        if (!Object.is(key, state._keys[index])) {
            state._keys[index] = key;
            state._sortDirty = true;
            state._fullUpload = true;
        } else if (!state._fullUpload) {
            markPackedDirty(state, state._inversePermutation[index]!);
        }
    }
}

function observeAdd(layer: Sprite2DLayer, index: number): void {
    const state = getState(layer);
    if (!state) {
        return;
    }
    ensureStorage(layer, state);
    state._biases[index] = state.defaultBias;
    state._serials[index] = allocateSerial(state);
    state._keys[index] = keyAt(layer, state, index);
    state._activeCount = layer.count;
    state._sortDirty = true;
    state._fullUpload = true;
}

function observeRemove(layer: Sprite2DLayer, index: number, last: number): void {
    const state = getState(layer);
    if (!state) {
        return;
    }
    if (index !== last) {
        state._biases[index] = state._biases[last]!;
        state._serials[index] = state._serials[last]!;
        state._keys[index] = state._keys[last]!;
    }
    state._biases[last] = 0;
    state._serials[last] = 0;
    state._keys[last] = 0;
    state._activeCount = layer.count;
    state._sortDirty = true;
    state._fullUpload = true;
}

function observeClear(layer: Sprite2DLayer, previousCount: number): void {
    const state = getState(layer);
    if (!state) {
        return;
    }
    state._biases.fill(0, 0, previousCount);
    state._serials.fill(0, 0, previousCount);
    state._keys.fill(0, 0, previousCount);
    state._activeCount = 0;
    state._sortDirty = true;
    state._fullUpload = true;
    state._dirtyMin = 0;
    state._dirtyMax = 0;
}

function packRange(layer: Sprite2DLayer, state: Sprite2DYSortState, lo: number, hi: number): void {
    const stride = layer._instanceFloatsPerSprite;
    for (let drawIndex = lo; drawIndex < hi; drawIndex++) {
        const logicalIndex = state._permutation[drawIndex]!;
        const sourceBase = logicalIndex * stride;
        const targetBase = drawIndex * stride;
        for (let lane = 0; lane < stride; lane++) {
            state._packedInstances[targetBase + lane] = layer._instanceData[sourceBase + lane]!;
        }
    }
}

function uploadSorted(device: GPUDevice, layer: Sprite2DLayer, instanceBuffer: GPUBuffer, uploadedVersion: number): number | undefined {
    const state = getState(layer);
    if (!state) {
        return undefined;
    }
    if (uploadedVersion === layer._version) {
        return uploadedVersion;
    }
    ensureSorted(layer, state);
    if (layer.count === 0) {
        layer._dirtyMin = 0;
        layer._dirtyMax = 0;
        state._dirtyMin = 0;
        state._dirtyMax = 0;
        return layer._version;
    }
    if (uploadedVersion === -1) {
        state._fullUpload = true;
    }
    const lo = state._fullUpload ? 0 : state._dirtyMin;
    const hi = state._fullUpload ? layer.count : Math.min(state._dirtyMax, layer.count);
    if (hi > lo) {
        packRange(layer, state, lo, hi);
        const offsetBytes = lo * layer._instanceStrideBytes;
        const bytes = (hi - lo) * layer._instanceStrideBytes;
        device.queue.writeBuffer(instanceBuffer, offsetBytes, state._packedInstances.buffer, state._packedInstances.byteOffset + offsetBytes, bytes);
    }
    layer._dirtyMin = 0;
    layer._dirtyMax = 0;
    state._fullUpload = false;
    state._dirtyMin = 0;
    state._dirtyMax = 0;
    return layer._version;
}

function getDrawOrder(layer: Sprite2DLayer): Uint32Array | null {
    const state = getState(layer);
    if (!state) {
        return null;
    }
    ensureSorted(layer, state);
    return state._permutation;
}

let _ySortHook: Sprite2DYSortHook | null = null;

function getHook(): Sprite2DYSortHook {
    return (_ySortHook ??= {
        add: observeAdd,
        remove: observeRemove,
        clear: observeClear,
        dirty: observeDirty,
        upload: uploadSorted,
        drawOrder: getDrawOrder,
    });
}

/**
 * Enable stable ascending Y-sort for a pure Sprite2D layer.
 *
 * The draw key is `positionPx.y + bias` in +Y-down layer space. Smaller keys draw first;
 * larger keys draw later and composite on top. Equal keys use a persistent insertion serial.
 * Canonical instance storage, logical indices, and stable handle mappings are never reordered.
 * Valid repeated calls return the installed state unchanged; `defaultBias` is validated on every
 * call but is used only when creating state. Re-enabling after disable creates fresh state, resets
 * active biases to the new default, and assigns insertion serials from zero in logical order.
 *
 * @param layer - A `depth: "none"` layer to sort.
 * @param options - Validated state-creation defaults.
 * @returns Layer-owned CPU sort state.
 * @throws If the layer is depth-hosted or `defaultBias` is not finite.
 */
export function enableSprite2DYSort(layer: Sprite2DLayer, options: Sprite2DYSortOptions = {}): Sprite2DYSortState {
    if (layer.depth !== "none") {
        throw new Error('enableSprite2DYSort: only depth: "none" layers are supported.');
    }
    const defaultBias = options.defaultBias ?? 0;
    if (!Number.isFinite(defaultBias)) {
        throw new Error("enableSprite2DYSort: defaultBias must be finite.");
    }
    const existing = getState(layer);
    if (existing) {
        return existing;
    }
    const capacity = layer._capacity;
    const state: Sprite2DYSortState = {
        layer,
        defaultBias,
        enabled: true,
        _permutation: new U32(capacity),
        _inversePermutation: new U32(capacity),
        _mergeScratch: new U32(capacity),
        _serials: new F64(capacity),
        _biases: new F64(capacity),
        _keys: new F64(capacity),
        _packedInstances: new F32(capacity * layer._instanceFloatsPerSprite),
        _capacity: capacity,
        _packedStride: layer._instanceFloatsPerSprite,
        _activeCount: layer.count,
        _nextSerial: 0,
        _sortDirty: true,
        _fullUpload: true,
        _dirtyMin: 0,
        _dirtyMax: 0,
    };
    for (let index = 0; index < layer.count; index++) {
        state._biases[index] = defaultBias;
        state._serials[index] = allocateSerial(state);
        state._keys[index] = keyAt(layer, state, index);
    }
    layer._ySortState = state;
    _registerSprite2DYSortHook(getHook());
    _markSprite2DDirty(layer, 0, layer.count);
    return state;
}

/**
 * Disable Y-sort, release its layer-owned state, and mark canonical logical order for upload.
 * A later enable creates fresh state rather than resuming biases or insertion serials.
 * @param layer - Layer to disable.
 * @returns `true` when installed state was removed; otherwise `false`.
 */
export function disableSprite2DYSort(layer: Sprite2DLayer): boolean {
    const state = getState(layer);
    if (!state) {
        return false;
    }
    (state as { enabled: boolean }).enabled = false;
    layer._ySortState = undefined;
    _markSprite2DDirty(layer, 0, layer.count);
    return true;
}

/**
 * Set the ordering bias for one canonical logical sprite slot.
 * @param layer - Enabled layer that owns the sprite.
 * @param index - Current Index API slot.
 * @param bias - Finite value added to `positionPx.y` for ordering only.
 */
export function setSprite2DYSortBias(layer: Sprite2DLayer, index: number, bias: number): void {
    const state = getState(layer);
    if (!state) {
        throw new Error("setSprite2DYSortBias: Y-sort is not enabled for this layer.");
    }
    if (index < 0 || index >= layer.count) {
        throw new Error(`setSprite2DYSortBias: index ${index} out of range [0, ${layer.count})`);
    }
    if (!Number.isFinite(bias)) {
        throw new Error("setSprite2DYSortBias: bias must be finite.");
    }
    if (state._biases[index] === bias) {
        return;
    }
    state._biases[index] = bias;
    const key = keyAt(layer, state, index);
    if (!Object.is(key, state._keys[index])) {
        state._keys[index] = key;
        state._sortDirty = true;
        state._fullUpload = true;
        _markSprite2DDirty(layer, index, index + 1);
    }
}
