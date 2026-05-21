/**
 * `Sprite2DLayer` — pixel-coordinate sprite layer. Pure-data interface +
 * standalone Index API for add / update / remove / setFrame. The layer is
 * owned by a `SpriteRenderer` (pure-2D / HUD `depth: "none"` path) or by a
 * scene renderable added through `addDepthHostedSpriteLayer`
 * (`depth: "test" | "test-write"`).
 *
 * The Index API stays the storage foundation. The optional Handle API lives in
 * `sprite-2d-handle.ts` and lazily installs hooks only when handles are used.
 */
import type { SpriteAtlas } from "./shared/sprite-atlas.js";
import { resolveSpriteFrame } from "./shared/sprite-atlas.js";

/** Output blend mode for a sprite layer. Currently supports `"alpha"` and `"premultiplied"`. */
export type SpriteBlendMode = "alpha" | "premultiplied" | "additive" | "multiply" | "cutout";

/** Depth participation. `"none"` uses `SpriteRenderer`; depth-enabled modes use `addToScene`. */
export type Sprite2DDepthMode = "none" | "test" | "test-write";

/** Per-layer 2D camera (pan / zoom / rotation). Identity = pixel-perfect HUD. */
export interface Sprite2DView {
    positionPx: [number, number];
    zoom: number;
    rotation: number;
}

/** Options accepted by `createSprite2DLayer`. */
export interface Sprite2DLayerOptions {
    capacity?: number;
    blendMode?: SpriteBlendMode;
    opacity?: number;
    visible?: boolean;
    order?: number;
    view?: Partial<Sprite2DView>;
    depth?: Sprite2DDepthMode;
    /**
     * Layer-wide rotation / scaling pivot in normalised sprite-local space
     * (`[0,0]` = top-left, `[0.5, 0.5]` = center, `[1,1]` = bottom-right).
     * The pivot point of every sprite in the layer lands at its `positionPx`
     * and is the center of `rotation`. Defaults to `[0.5, 0.5]` (center) to
     * match Babylon.js sprite behavior. Per-sprite / per-frame pivot is a
     * future PR — most 2D HUD layers want one uniform pivot anyway.
     */
    pivot?: [number, number];
    /**
     * Default NDC depth (`0` = near, `1` = far) for sprites added to this layer when their
     * `Sprite2DProps.z` is omitted. Only meaningful for `depth: "test" | "test-write"` layers
     * (depth-hosted sprites added to a `SceneContext` via `addDepthHostedSpriteLayer`).
     *
     * Depth-hosted layers store one Z per sprite (slot [13] of their 14-float instance buffer),
     * so a single layer can mix sprites at different depths — e.g. one in front of a box, one
     * behind it. Pure-2D layers (`depth: "none"`) use the 13-float HUD layout and carry no Z slot.
     * Defaults to `0.5`. Mutating `layer.layerZ` after sprites have been added does **not**
     * retroactively change them; it only affects sprites added afterwards. To move an existing
     * depth-hosted sprite, call `updateSprite2DIndex(layer, idx, { z: … })`.
     */
    layerZ?: number;
}

/** A `Sprite2DLayer` — pure data, no methods. */
export interface Sprite2DLayer {
    readonly _entityType: "sprite-2d-layer";
    readonly atlas: SpriteAtlas;
    readonly depth: Sprite2DDepthMode;
    readonly blendMode: SpriteBlendMode;
    opacity: number;
    visible: boolean;
    order: number;
    view: Sprite2DView;
    /** Layer-wide pivot in normalised sprite-local space; see `Sprite2DLayerOptions.pivot`. */
    pivot: [number, number];
    /** Default NDC depth for newly added sprites; see `Sprite2DLayerOptions.layerZ`. */
    layerZ: number;
    readonly count: number;

    /** @internal Capacity of the per-instance buffer (in sprites). */
    _capacity: number;
    /** @internal Per-instance stride in floats; 13 for pure-2D, 14 for depth-hosted. */
    readonly _instanceFloatsPerSprite: number;
    /** @internal Per-instance stride in bytes; 52 for pure-2D, 56 for depth-hosted. */
    readonly _instanceStrideBytes: number;
    /** @internal Per-instance CPU staging buffer; layout = `_instanceFloatsPerSprite` per sprite. */
    _instanceData: Float32Array;
    /**
     * @internal CPU-only side buffer holding the **true** (un-hidden) size of every sprite,
     * laid out as `[w0, h0, w1, h1, …]` (`SAVED_SIZE_FLOATS_PER_SPRITE` = 2 floats per sprite).
     *
     * **Invariant:** this buffer always holds the sprite's real size, regardless of visibility.
     * It exists because `visible: false` is implemented by zeroing the GPU-side size slots
     * (degenerate quad → free rasterizer cull) — a free hide on the GPU at the cost of 8 B per
     * sprite on the CPU. Without this shadow, a `visible: true` patch that omits `sizePx`
     * would have no way to recover the original size. Grown in lockstep with `_instanceData`.
     */
    _savedSize: Float32Array;
    /** @internal Bumped on any structural / per-instance edit; renderer compares. */
    _version: number;
    /** @internal Min dirty index inclusive (for partial uploads). */
    _dirtyMin: number;
    /** @internal Max dirty index exclusive. */
    _dirtyMax: number;
    /** @internal Optional hooks installed by the opt-in handle module. */
    _handleHooks?: Sprite2DIndexHandleHooks;
}

/** @internal Lazy hooks used by the opt-in Handle API to track swap-removes. */
export interface Sprite2DIndexHandleHooks {
    readonly removeIndex: (index: number, last: number) => void;
    readonly clear: () => void;
}

/** Per-sprite init record passed to `addSprite2DIndex` / `updateSprite2DIndex`. */
export interface Sprite2DProps {
    positionPx: [number, number];
    sizePx?: [number, number];
    frame?: number;
    rotation?: number;
    color?: [number, number, number, number];
    flipX?: boolean;
    flipY?: boolean;
    visible?: boolean;
    /** Reserved for picking. Accepted but unused today. */
    pickable?: boolean;
    /** Reserved for clip animation. Accepted but unused today. */
    clip?: unknown;
    /**
     * Per-sprite NDC depth (`0` = near, `1` = far). Only stored and consumed by depth-hosted
     * layers (`depth: "test" | "test-write"`); pure-2D HUD layers use a 13-float layout and
     * do not allocate a Z slot. When omitted on add for a depth-hosted layer, defaults to the
     * **owning layer's** `layerZ` at the moment of insertion. When omitted on update, the
     * sprite's existing Z is preserved. Mutate freely — the next binding update will re-upload
     * only the dirty range.
     */
    z?: number;
}

/**
 * Pure-2D per-instance vertex layout (13 floats = 52 bytes, `depth: "none"`):
 *   [0..1]  positionPx.xy   (float32x2 @ offset  0)
 *   [2..3]  sizePx.xy       (float32x2 @ offset  8)
 *   [4..5]  uvMin.xy        (float32x2 @ offset 16)
 *   [6..7]  uvMax.xy        (float32x2 @ offset 24)
 *   [8]     rotation        (float32   @ offset 32)
 *   [9..12] colorRGBA       (float32x4 @ offset 36)
 *
 * Depth-hosted layers (`depth: "test" | "test-write"`) extend this to 14 floats = 56 bytes:
 *   [13]    z (NDC depth)   (float32   @ offset 52, consumed only by depth-hosted pipelines)
 *
 * Visibility (`visible: false`) is implemented by zeroing slots [2..3]; the sprite's true
 * size lives in `layer._savedSize` so a later `visible: true` (without re-supplying
 * `sizePx`) can restore it. See `_savedSize` for the invariant.
 */
export const PURE_2D_INSTANCE_FLOATS_PER_SPRITE = 13;
export const DEPTH_INSTANCE_FLOATS_PER_SPRITE = 14;
/** @internal Pure-2D per-sprite stride in bytes. */
export const PURE_2D_INSTANCE_STRIDE_BYTES = PURE_2D_INSTANCE_FLOATS_PER_SPRITE * 4;
/** @internal Depth-hosted per-sprite stride in bytes. */
export const DEPTH_INSTANCE_STRIDE_BYTES = DEPTH_INSTANCE_FLOATS_PER_SPRITE * 4;
/** @internal Per-sprite stride (in floats) of the `_savedSize` shadow buffer: `[w, h]`. */
export const SAVED_SIZE_FLOATS_PER_SPRITE = 2;

const DEFAULT_CAPACITY = 16;

function assertBlendSupported(blendMode: SpriteBlendMode): void {
    if (blendMode === "additive" || blendMode === "multiply" || blendMode === "cutout") {
        throw new Error(`Sprite2DLayer: blendMode: "${blendMode}" lands in a later PR. Use "alpha" or "premultiplied".`);
    }
}

/** Create a new (empty) `Sprite2DLayer` backed by `atlas`. */
export function createSprite2DLayer(atlas: SpriteAtlas, opts: Sprite2DLayerOptions = {}): Sprite2DLayer {
    const depth = opts.depth ?? "none";
    const blendMode = opts.blendMode ?? "alpha";
    assertBlendSupported(blendMode);

    const capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    const view: Sprite2DView = {
        positionPx: [opts.view?.positionPx?.[0] ?? 0, opts.view?.positionPx?.[1] ?? 0],
        zoom: opts.view?.zoom ?? 1,
        rotation: opts.view?.rotation ?? 0,
    };

    const instanceFloatsPerSprite = depth === "none" ? PURE_2D_INSTANCE_FLOATS_PER_SPRITE : DEPTH_INSTANCE_FLOATS_PER_SPRITE;
    const instanceStrideBytes = instanceFloatsPerSprite * 4;
    const instanceData = new Float32Array(capacity * instanceFloatsPerSprite);
    return {
        _entityType: "sprite-2d-layer",
        atlas,
        depth,
        blendMode,
        opacity: opts.opacity ?? 1,
        visible: opts.visible ?? true,
        order: opts.order ?? 0,
        view,
        pivot: [opts.pivot?.[0] ?? 0.5, opts.pivot?.[1] ?? 0.5],
        layerZ: opts.layerZ ?? 0.5,
        count: 0,
        _capacity: capacity,
        _instanceFloatsPerSprite: instanceFloatsPerSprite,
        _instanceStrideBytes: instanceStrideBytes,
        _instanceData: instanceData,
        _savedSize: new Float32Array(capacity * SAVED_SIZE_FLOATS_PER_SPRITE),
        _version: 0,
        _dirtyMin: 0,
        _dirtyMax: 0,
    };
}

function growCapacity(layer: Sprite2DLayer, minCapacity: number): void {
    let cap = layer._capacity;
    while (cap < minCapacity) {
        cap *= 2;
    }
    const next = new Float32Array(cap * layer._instanceFloatsPerSprite);
    next.set(layer._instanceData);
    layer._instanceData = next;
    const nextSaved = new Float32Array(cap * SAVED_SIZE_FLOATS_PER_SPRITE);
    nextSaved.set(layer._savedSize);
    layer._savedSize = nextSaved;
    layer._capacity = cap;
}

function setSprite2DCount(layer: Sprite2DLayer, count: number): void {
    (layer as { count: number }).count = count;
}

/**
 * Write one sprite's instance data into `layer._instanceData[base..base+layer._instanceFloatsPerSprite]`.
 *
 * Two call sites with different shapes:
 *   - **add**: `prev === null`. `props` is a full `Sprite2DProps` (positionPx required).
 *               Unspecified fields take their documented defaults (size=frame.sourceSizePx or 0,
 *               UVs=[0,0,1,1], rotation=0, color=opaque white, visible=true).
 *   - **update**: `prev` is the existing per-layer instance slice. Unspecified fields are preserved.
 *
 * Resolution rules (per field): `props` value if given, else (on add) the default, else `prev`.
 * `frame` is a higher-level intent: when supplied it stomps the four UV slots from the atlas
 * (then `flipX`/`flipY` swap them). It does **not** by itself imply a size change — `sizePx`
 * remains independent — but on add, a missing `sizePx` falls back to `frame.sourceSizePx`.
 *
 * **Visibility model (the part that needs explaining):**
 *   - `_savedSize[slot]` always stores the sprite's *true* size (unaffected by visibility).
 *   - `data[base+2..+3]` (the GPU-visible size) is `_savedSize` when visible, else `(0, 0)`.
 *   - We detect previous visibility by checking `prev[2]==0 && prev[3]==0` (only hidden sprites
 *     have zeroed GPU size). The CPU shadow gives us back the true size for free.
 */
function writeInstance(layer: Sprite2DLayer, slotIndex: number, props: Partial<Sprite2DProps>, prev: Float32Array | null): void {
    const data = layer._instanceData;
    const base = slotIndex * layer._instanceFloatsPerSprite;
    const savedBase = slotIndex * SAVED_SIZE_FLOATS_PER_SPRITE; // [w, h] per sprite
    const isAdd = prev === null;

    // Optional frame lookup (used for UV stomp + size default on add).
    const frame = props.frame !== undefined ? layer.atlas.frames[resolveSpriteFrame(layer.atlas, props.frame)]! : null;

    // ── Position (required on add; preserved on update if omitted) ──────────────────────
    const posX = props.positionPx ? props.positionPx[0] : prev![0]!;
    const posY = props.positionPx ? props.positionPx[1] : prev![1]!;

    // ── True size (props.sizePx → frame default → previous true size) ───────────────────
    // The shadow buffer makes "previous true size" cheap and unambiguous regardless of visibility.
    let trueW: number;
    let trueH: number;
    if (props.sizePx) {
        trueW = props.sizePx[0];
        trueH = props.sizePx[1];
    } else if (frame) {
        trueW = frame.sourceSizePx[0];
        trueH = frame.sourceSizePx[1];
    } else if (isAdd) {
        trueW = 0;
        trueH = 0;
    } else {
        trueW = layer._savedSize[savedBase]!;
        trueH = layer._savedSize[savedBase + 1]!;
    }
    layer._savedSize[savedBase] = trueW;
    layer._savedSize[savedBase + 1] = trueH;

    // ── Visibility (props.visible → preserved → default true on add) ────────────────────
    let visible: boolean;
    if (props.visible !== undefined) {
        visible = props.visible;
    } else if (isAdd) {
        visible = true;
    } else {
        // Previous sprite was hidden iff its GPU size was zeroed.
        visible = prev![2]! !== 0 || prev![3]! !== 0;
    }

    // ── UVs (frame stomps; else preserved; else default [0,0,1,1] on add) ───────────────
    // flipX/flipY apply on top, by swapping the U/V endpoints.
    let uMin: number;
    let vMin: number;
    let uMax: number;
    let vMax: number;
    if (frame) {
        uMin = frame.uvMin[0];
        vMin = frame.uvMin[1];
        uMax = frame.uvMax[0];
        vMax = frame.uvMax[1];
    } else if (isAdd) {
        uMin = 0;
        vMin = 0;
        uMax = 1;
        vMax = 1;
    } else {
        uMin = prev![4]!;
        vMin = prev![5]!;
        uMax = prev![6]!;
        vMax = prev![7]!;
    }
    if (props.flipX === true) {
        const t = uMin;
        uMin = uMax;
        uMax = t;
    }
    if (props.flipY === true) {
        const t = vMin;
        vMin = vMax;
        vMax = t;
    }

    // ── Rotation ────────────────────────────────────────────────────────────────────────
    const rotation = props.rotation ?? (prev ? prev[8]! : 0);

    // ── Per-instance Z (depth-hosted only) ──────────────────────────────────────────────
    // Pure-2D layers intentionally have no slot [13]; `z` is accepted by the public API but
    // not allocated, uploaded, declared, or fetched by HUD pipelines.
    const hasDepthSlot = layer.depth !== "none";
    const z = hasDepthSlot ? (props.z ?? (prev ? prev[13]! : layer.layerZ)) : 0;

    // ── Write the float slots ──────────────────────────────────────────────────────────
    data[base + 0] = posX;
    data[base + 1] = posY;
    data[base + 2] = visible ? trueW : 0;
    data[base + 3] = visible ? trueH : 0;
    data[base + 4] = uMin;
    data[base + 5] = vMin;
    data[base + 6] = uMax;
    data[base + 7] = vMax;
    data[base + 8] = rotation;

    // ── Color (float32x4 to match Babylon.js SpriteRenderer's color precision) ─────────
    if (props.color) {
        data[base + 9] = props.color[0];
        data[base + 10] = props.color[1];
        data[base + 11] = props.color[2];
        data[base + 12] = props.color[3];
    } else if (isAdd) {
        data[base + 9] = 1;
        data[base + 10] = 1;
        data[base + 11] = 1;
        data[base + 12] = 1;
    }
    // else: previous color floats are already in place — nothing to write.

    // ── Per-instance Z (slot [13], depth-hosted layout only) ───────────────────────────
    if (hasDepthSlot) {
        data[base + 13] = z;
    }
}

function markDirty(layer: Sprite2DLayer, lo: number, hi: number): void {
    if (layer._dirtyMin >= layer._dirtyMax) {
        layer._dirtyMin = lo;
        layer._dirtyMax = hi;
    } else {
        if (lo < layer._dirtyMin) {
            layer._dirtyMin = lo;
        }
        if (hi > layer._dirtyMax) {
            layer._dirtyMax = hi;
        }
    }
    layer._version = (layer._version + 1) | 0;
}

/** Add one sprite. Returns its index. Grows capacity as needed. */
export function addSprite2DIndex(layer: Sprite2DLayer, props: Sprite2DProps): number {
    if (props.positionPx === undefined) {
        throw new Error("addSprite2DIndex: props.positionPx is required.");
    }
    const idx = layer.count;
    if (idx >= layer._capacity) {
        growCapacity(layer, idx + 1);
    }
    writeInstance(layer, idx, props, null);
    setSprite2DCount(layer, layer.count + 1);
    markDirty(layer, idx, idx + 1);
    return idx;
}

/** Patch one sprite. Unspecified fields are preserved. */
export function updateSprite2DIndex(layer: Sprite2DLayer, index: number, patch: Partial<Sprite2DProps>): void {
    if (index < 0 || index >= layer.count) {
        throw new Error(`updateSprite2DIndex: index ${index} out of range [0, ${layer.count})`);
    }
    const base = index * layer._instanceFloatsPerSprite;
    const prev = layer._instanceData.subarray(base, base + layer._instanceFloatsPerSprite);
    writeInstance(layer, index, patch, prev);
    markDirty(layer, index, index + 1);
}

/** Swap-remove a sprite. The last sprite (if any) takes its slot. */
export function removeSprite2DIndex(layer: Sprite2DLayer, index: number): void {
    if (index < 0 || index >= layer.count) {
        throw new Error(`removeSprite2DIndex: index ${index} out of range [0, ${layer.count})`);
    }
    const last = layer.count - 1;
    layer._handleHooks?.removeIndex(index, last);
    if (index !== last) {
        layer._instanceData.copyWithin(index * layer._instanceFloatsPerSprite, last * layer._instanceFloatsPerSprite, (last + 1) * layer._instanceFloatsPerSprite);
        // Carry the swapped sprite's saved-size shadow with it (`[w, h]` per sprite).
        layer._savedSize.copyWithin(index * SAVED_SIZE_FLOATS_PER_SPRITE, last * SAVED_SIZE_FLOATS_PER_SPRITE, (last + 1) * SAVED_SIZE_FLOATS_PER_SPRITE);
    }
    // Clear the now-unused tail saved-size slot so a future re-add starts clean.
    layer._savedSize[last * SAVED_SIZE_FLOATS_PER_SPRITE] = 0;
    layer._savedSize[last * SAVED_SIZE_FLOATS_PER_SPRITE + 1] = 0;
    setSprite2DCount(layer, last);
    markDirty(layer, index, index + 1);
}

/** Clear all sprites from a layer while preserving allocated capacity. */
export function clearSprite2DLayer(layer: Sprite2DLayer): void {
    const count = layer.count;
    layer._dirtyMin = 0;
    layer._dirtyMax = 0;
    layer._handleHooks?.clear();
    if (count === 0) {
        return;
    }
    layer._savedSize.fill(0, 0, count * SAVED_SIZE_FLOATS_PER_SPRITE);
    setSprite2DCount(layer, 0);
    layer._version = (layer._version + 1) | 0;
}

/** Update only the frame UVs for one sprite. */
export function setSprite2DFrameIndex(layer: Sprite2DLayer, index: number, frame: number): void {
    if (index < 0 || index >= layer.count) {
        throw new Error(`setSprite2DFrameIndex: index ${index} out of range [0, ${layer.count})`);
    }
    const frameIdx = resolveSpriteFrame(layer.atlas, frame);
    const f = layer.atlas.frames[frameIdx]!;
    const base = index * layer._instanceFloatsPerSprite;
    layer._instanceData[base + 4] = f.uvMin[0];
    layer._instanceData[base + 5] = f.uvMin[1];
    layer._instanceData[base + 6] = f.uvMax[0];
    layer._instanceData[base + 7] = f.uvMax[1];
    markDirty(layer, index, index + 1);
}
