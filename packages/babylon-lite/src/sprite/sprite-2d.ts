/**
 * `Sprite2DLayer` — pixel-coordinate sprite layer. Pure-data interface +
 * standalone Index API for add / update / remove / setFrame. The layer is
 * owned by a `SpriteRenderer` (pure-2D path) or, in a later PR, by a
 * `SceneContext` (HUD / depth-hosted paths).
 *
 * PR 1 implements the Index API only. Animation, clip playback, and the
 * Handle API land in later PRs.
 */
import type { SpriteAtlas } from "./shared/sprite-atlas.js";
import { resolveSpriteFrame } from "./shared/sprite-atlas.js";

/** Output blend mode for a sprite layer. PR 1 supports `"alpha"` and `"premultiplied"`. */
export type SpriteBlendMode = "alpha" | "premultiplied" | "additive" | "multiply" | "cutout";

/** Depth participation. PR 1 implements `"none"` only. */
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
}

/** A `Sprite2DLayer` — pure data, no methods. */
export interface Sprite2DLayer {
    readonly _entityType: "sprite-2d-layer";
    readonly atlas: SpriteAtlas;
    readonly depth: Sprite2DDepthMode;
    blendMode: SpriteBlendMode;
    opacity: number;
    visible: boolean;
    order: number;
    view: Sprite2DView;
    /** Layer-wide pivot in normalised sprite-local space; see `Sprite2DLayerOptions.pivot`. */
    pivot: [number, number];
    count: number;

    /** @internal Capacity of the per-instance buffer (in sprites). */
    _capacity: number;
    /** @internal Per-instance CPU staging buffer; layout = INSTANCE_FLOATS_PER_SPRITE per sprite. */
    _instanceData: Float32Array;
    /** @internal `Uint32` view aliased onto `_instanceData.buffer` for in-place packed-int writes
     *  (color slot). Re-created whenever `_instanceData` is reallocated. */
    _instanceDataU32: Uint32Array;
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
    /** Reserved for picking (PR 5). Accepted but unused in PR 1. */
    pickable?: boolean;
    /** Reserved for clip animation (later PR). Accepted but unused in PR 1. */
    clip?: unknown;
}

/**
 * Per-instance vertex layout (10 floats = 40 bytes):
 *   [0..1]  positionPx.xy   (float32x2 @ offset  0)
 *   [2..3]  sizePx.xy       (float32x2 @ offset  8)
 *   [4..5]  uvMin.xy        (float32x2 @ offset 16)
 *   [6..7]  uvMax.xy        (float32x2 @ offset 24)
 *   [8]     rotation        (float32   @ offset 32)
 *   [9]     colorRGBA       (unorm8x4  @ offset 36, packed via the aliased Uint32 view)
 *
 * The renderer treats slot [9] as a `unorm8x4` vertex attribute (4 bytes seen as RGBA on the
 * GPU). Float32Array is just a convenient homogeneous backing store; the bits are written
 * via the cached `_instanceDataU32` view on `layer._instanceData.buffer`.
 *
 * Visibility (`visible: false`) is implemented by zeroing slots [2..3]; the sprite's true
 * size lives in `layer._savedSize` so a later `visible: true` (without re-supplying
 * `sizePx`) can restore it. See `_savedSize` for the invariant.
 */
export const INSTANCE_FLOATS_PER_SPRITE = 10;
/** @internal Per-sprite stride in bytes — kept in sync with INSTANCE_FLOATS_PER_SPRITE. */
export const INSTANCE_STRIDE_BYTES = INSTANCE_FLOATS_PER_SPRITE * 4;
/** @internal Per-sprite stride (in floats) of the `_savedSize` shadow buffer: `[w, h]`. */
export const SAVED_SIZE_FLOATS_PER_SPRITE = 2;

const DEFAULT_CAPACITY = 16;

function assertDepthSupported(depth: Sprite2DDepthMode): void {
    if (depth === "test" || depth === "test-write") {
        throw new Error(`Sprite2DLayer: depth: "${depth}" lands in PR 3. Use "none" for now.`);
    }
}

function assertBlendSupported(blendMode: SpriteBlendMode): void {
    if (blendMode === "additive" || blendMode === "multiply" || blendMode === "cutout") {
        throw new Error(`Sprite2DLayer: blendMode: "${blendMode}" lands in a later PR. Use "alpha" or "premultiplied".`);
    }
}

/** Create a new (empty) `Sprite2DLayer` backed by `atlas`. */
export function createSprite2DLayer(atlas: SpriteAtlas, opts: Sprite2DLayerOptions = {}): Sprite2DLayer {
    const depth = opts.depth ?? "none";
    assertDepthSupported(depth);
    const blendMode = opts.blendMode ?? "alpha";
    assertBlendSupported(blendMode);

    const capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    const view: Sprite2DView = {
        positionPx: [opts.view?.positionPx?.[0] ?? 0, opts.view?.positionPx?.[1] ?? 0],
        zoom: opts.view?.zoom ?? 1,
        rotation: opts.view?.rotation ?? 0,
    };

    const instanceData = new Float32Array(capacity * INSTANCE_FLOATS_PER_SPRITE);
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
        count: 0,
        _capacity: capacity,
        _instanceData: instanceData,
        _instanceDataU32: new Uint32Array(instanceData.buffer),
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
    const next = new Float32Array(cap * INSTANCE_FLOATS_PER_SPRITE);
    next.set(layer._instanceData);
    layer._instanceData = next;
    layer._instanceDataU32 = new Uint32Array(next.buffer);
    const nextSaved = new Float32Array(cap * SAVED_SIZE_FLOATS_PER_SPRITE);
    nextSaved.set(layer._savedSize);
    layer._savedSize = nextSaved;
    layer._capacity = cap;
}

function packColor(r: number, g: number, b: number, a: number): number {
    const ri = Math.max(0, Math.min(255, Math.round(r * 255)));
    const gi = Math.max(0, Math.min(255, Math.round(g * 255)));
    const bi = Math.max(0, Math.min(255, Math.round(b * 255)));
    const ai = Math.max(0, Math.min(255, Math.round(a * 255)));
    // Little-endian: byte 0 = R, byte 1 = G, byte 2 = B, byte 3 = A.
    return (ri | (gi << 8) | (bi << 16) | (ai << 24)) >>> 0;
}

/**
 * Write one sprite's instance data into `layer._instanceData[base..base+INSTANCE_FLOATS_PER_SPRITE]`.
 *
 * Two call sites with different shapes:
 *   - **add**: `prev === null`. `props` is a full `Sprite2DProps` (positionPx required).
 *               Unspecified fields take their documented defaults (size=frame.sourceSizePx or 0,
 *               UVs=[0,0,1,1], rotation=0, color=opaque white, visible=true).
 *   - **update**: `prev` is the existing 10-float slice. Unspecified fields are preserved.
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
    const u32 = layer._instanceDataU32;
    const base = slotIndex * INSTANCE_FLOATS_PER_SPRITE;
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

    // ── Write the 9 float slots (color is the 10th, written below via the U32 view) ────
    data[base + 0] = posX;
    data[base + 1] = posY;
    data[base + 2] = visible ? trueW : 0;
    data[base + 3] = visible ? trueH : 0;
    data[base + 4] = uMin;
    data[base + 5] = vMin;
    data[base + 6] = uMax;
    data[base + 7] = vMax;
    data[base + 8] = rotation;

    // ── Color (packed into slot [9] via the cached Uint32 view) ─────────────────────────
    // Aliased write — the 4 bytes are the same the GPU samples as unorm8x4.
    if (props.color) {
        u32[base + 9] = packColor(props.color[0], props.color[1], props.color[2], props.color[3]);
    } else if (isAdd) {
        u32[base + 9] = 0xffffffff; // opaque white
    }
    // else: prev's color bits are already in `data[base+9]` — nothing to write.
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
    layer.count++;
    markDirty(layer, idx, idx + 1);
    return idx;
}

/** Patch one sprite. Unspecified fields are preserved. */
export function updateSprite2DIndex(layer: Sprite2DLayer, index: number, patch: Partial<Sprite2DProps>): void {
    if (index < 0 || index >= layer.count) {
        throw new Error(`updateSprite2DIndex: index ${index} out of range [0, ${layer.count})`);
    }
    const base = index * INSTANCE_FLOATS_PER_SPRITE;
    const prev = layer._instanceData.subarray(base, base + INSTANCE_FLOATS_PER_SPRITE);
    writeInstance(layer, index, patch, prev);
    markDirty(layer, index, index + 1);
}

/** Swap-remove a sprite. The last sprite (if any) takes its slot. */
export function removeSprite2DIndex(layer: Sprite2DLayer, index: number): void {
    if (index < 0 || index >= layer.count) {
        throw new Error(`removeSprite2DIndex: index ${index} out of range [0, ${layer.count})`);
    }
    const last = layer.count - 1;
    if (index !== last) {
        layer._instanceData.copyWithin(index * INSTANCE_FLOATS_PER_SPRITE, last * INSTANCE_FLOATS_PER_SPRITE, (last + 1) * INSTANCE_FLOATS_PER_SPRITE);
        // Carry the swapped sprite's saved-size shadow with it (`[w, h]` per sprite).
        layer._savedSize.copyWithin(index * SAVED_SIZE_FLOATS_PER_SPRITE, last * SAVED_SIZE_FLOATS_PER_SPRITE, (last + 1) * SAVED_SIZE_FLOATS_PER_SPRITE);
    }
    // Clear the now-unused tail saved-size slot so a future re-add starts clean.
    layer._savedSize[last * SAVED_SIZE_FLOATS_PER_SPRITE] = 0;
    layer._savedSize[last * SAVED_SIZE_FLOATS_PER_SPRITE + 1] = 0;
    markDirty(layer, index, index + 1);
    layer.count--;
}

/** Update only the frame UVs for one sprite. */
export function setSprite2DFrameIndex(layer: Sprite2DLayer, index: number, frame: number): void {
    if (index < 0 || index >= layer.count) {
        throw new Error(`setSprite2DFrameIndex: index ${index} out of range [0, ${layer.count})`);
    }
    const frameIdx = resolveSpriteFrame(layer.atlas, frame);
    const f = layer.atlas.frames[frameIdx]!;
    const base = index * INSTANCE_FLOATS_PER_SPRITE;
    layer._instanceData[base + 4] = f.uvMin[0];
    layer._instanceData[base + 5] = f.uvMin[1];
    layer._instanceData[base + 6] = f.uvMax[0];
    layer._instanceData[base + 7] = f.uvMax[1];
    markDirty(layer, index, index + 1);
}
