/**
 * Native bridge from NPE's data-oriented {@link ParticleSystem} to a pure-2D
 * {@link Sprite2DLayer}.
 *
 * The bridge owns the layer's complete live range. Each sync writes NPE's compact
 * `[0, buffer.alive)` columns directly into the Sprite2D instance buffer and marks
 * one dirty range, with no per-particle objects or allocations.
 *
 * NPE positions use world-space XY with +Y up, while pure Sprite2D commonly uses
 * pixel-space XY with +Y down. The bridge makes that conversion explicit:
 * `pixelsPerUnit` scales position and size, `originPx` places the NPE origin in the
 * Sprite2D world, and `invertY` (default true) mirrors Y and rotation.
 *
 * The particle texture remains owned by the ParticleSystem. Discarding the bridge
 * or its layer does not dispose that texture.
 */
import { createGridSpriteAtlas, resolveSpriteFrame } from "../sprite/shared/sprite-atlas.js";
import { spriteBlendAdditive, spriteBlendAlpha, spriteBlendOneOne, type SpriteBlendDescriptor } from "../sprite/sprite-blend.js";
import { _markSprite2DDirty, _setSprite2DCount, createSprite2DLayer, SAVED_SIZE_FLOATS_PER_SPRITE, type Sprite2DLayer, type Sprite2DLayerOptions } from "../sprite/sprite-2d.js";
import type { ParticleSystem } from "./particle-system.js";
import { animateParticleSystem, startParticleSystem } from "./particle-system.js";
import type { NodeParticleSet } from "./node/node-particle.js";
import { addSpriteRendererLayer, removeSpriteRendererLayer, type SpriteRenderer } from "../sprite/sprite-renderer.js";

const BLENDMODE_ONEONE = 0;
const BLENDMODE_STANDARD = 1;
const FRAME_MS = 1000 / 60;

/** Options for {@link createParticleSprite2DBridge}. */
export interface ParticleSprite2DBridgeOptions {
    /** Sprite pixels per NPE world unit. Default 1. */
    pixelsPerUnit?: number;
    /** Sprite2D world position of the NPE origin. Default `[0, 0]`. */
    originPx?: readonly [number, number];
    /** Convert NPE +Y-up to Sprite2D +Y-down and mirror rotation. Default true. */
    invertY?: boolean;
    /** Layer presentation options. Capacity, depth, blend, and pivot are bridge-owned. */
    layer?: Pick<Sprite2DLayerOptions, "opacity" | "visible" | "order" | "view">;
}

/**
 * Pure-state connection between one NPE system and one exclusively-owned
 * Sprite2D layer. Mutate the mapping fields when the unit scale or origin moves.
 */
export interface ParticleSprite2DBridge {
    readonly system: ParticleSystem;
    readonly layer: Sprite2DLayer;
    pixelsPerUnit: number;
    originPx: [number, number];
    invertY: boolean;
}

/** Options for {@link registerNodeParticleSet2D}. */
export interface RegisterNodeParticleSet2DOptions extends ParticleSprite2DBridgeOptions {
    /** Start emission immediately. Default true. */
    autoStart?: boolean;
}

/** Binding returned by {@link registerNodeParticleSet2D}. */
export interface NodeParticleSet2DBinding {
    /** @internal */
    readonly _entityType: "node-particle-set-2d-binding";
    readonly bridges: readonly ParticleSprite2DBridge[];
    active: boolean;
    /** @internal */
    _dispose: () => void;
}

function blendForMode(mode: number): SpriteBlendDescriptor {
    if (mode === BLENDMODE_STANDARD) {
        return spriteBlendAlpha;
    }
    if (mode === BLENDMODE_ONEONE) {
        return spriteBlendOneOne;
    }
    return spriteBlendAdditive;
}

/**
 * Create a pure-2D render bridge for `system`.
 *
 * The NPE graph's texture loads asynchronously; call this only after graph build
 * promises have settled and `system.texture` is available.
 */
export function createParticleSprite2DBridge(system: ParticleSystem, options: ParticleSprite2DBridgeOptions = {}): ParticleSprite2DBridge {
    const texture = system.texture;
    if (!texture) {
        throw new Error("createParticleSprite2DBridge: the particle system has no texture");
    }
    const pixelsPerUnit = options.pixelsPerUnit ?? 1;
    if (!(pixelsPerUnit > 0) || !Number.isFinite(pixelsPerUnit)) {
        throw new Error(`createParticleSprite2DBridge: pixelsPerUnit must be a positive finite number, got ${pixelsPerUnit}`);
    }
    const origin = options.originPx ?? [0, 0];
    if (!Number.isFinite(origin[0]) || !Number.isFinite(origin[1])) {
        throw new Error(`createParticleSprite2DBridge: originPx must be finite, got [${origin[0]}, ${origin[1]}]`);
    }

    const sheet = system._spriteSheet;
    const atlas = createGridSpriteAtlas(texture, {
        cellWidthPx: sheet && sheet.cellWidth > 0 ? sheet.cellWidth : texture.width,
        cellHeightPx: sheet && sheet.cellHeight > 0 ? sheet.cellHeight : texture.height,
        pivot: [0.5, 0.5],
    });
    const layerOptions = options.layer;
    const layer = createSprite2DLayer(atlas, {
        capacity: system.buffer.capacity,
        blendMode: blendForMode(system.blendMode),
        opacity: layerOptions?.opacity,
        visible: layerOptions?.visible,
        order: layerOptions?.order,
        view: layerOptions?.view,
        depth: "none",
        pivot: [0.5, 0.5],
    });

    return {
        system,
        layer,
        pixelsPerUnit,
        originPx: [origin[0], origin[1]],
        invertY: options.invertY ?? true,
    };
}

/**
 * Copy the bridge's current live NPE columns into its Sprite2D layer.
 *
 * The bridge owns every layer slot. Do not add independent sprites or install the
 * Sprite2D Handle API on this layer; sync replaces its complete live range.
 */
export function syncParticleSprite2DBridge(bridge: ParticleSprite2DBridge): void {
    const { system, layer } = bridge;
    if (layer._handleHooks) {
        throw new Error("syncParticleSprite2DBridge: the bridge-owned layer cannot use the Sprite2D Handle API");
    }
    const pixelsPerUnit = bridge.pixelsPerUnit;
    if (!(pixelsPerUnit > 0) || !Number.isFinite(pixelsPerUnit)) {
        throw new Error(`syncParticleSprite2DBridge: pixelsPerUnit must be a positive finite number, got ${pixelsPerUnit}`);
    }
    const originX = bridge.originPx[0];
    const originY = bridge.originPx[1];
    if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
        throw new Error(`syncParticleSprite2DBridge: originPx must be finite, got [${originX}, ${originY}]`);
    }

    const buffer = system.buffer;
    const alive = buffer.alive;
    const previousCount = layer.count;
    const stride = layer._instanceFloatsPerSprite;
    const data = layer._instanceData;
    const savedSize = layer._savedSize;
    const cellIndex = system._spriteSheet?.cellIndex;
    const ySign = bridge.invertY ? -1 : 1;

    for (let i = 0; i < alive; i++) {
        const base = i * stride;
        const savedBase = i * SAVED_SIZE_FLOATS_PER_SPRITE;
        const width = buffer.size[i]! * buffer.scaleX[i]! * pixelsPerUnit;
        const height = buffer.size[i]! * buffer.scaleY[i]! * pixelsPerUnit;
        const frameIndex = resolveSpriteFrame(layer.atlas, cellIndex ? cellIndex[i]! : 0);
        const frame = layer.atlas.frames[frameIndex]!;

        data[base] = originX + buffer.posX[i]! * pixelsPerUnit;
        data[base + 1] = originY + buffer.posY[i]! * pixelsPerUnit * ySign;
        data[base + 2] = width;
        data[base + 3] = height;
        data[base + 4] = frame.uvMin[0];
        data[base + 5] = frame.uvMin[1];
        data[base + 6] = frame.uvMax[0];
        data[base + 7] = frame.uvMax[1];
        data[base + 8] = buffer.angle[i]! * ySign;
        data[base + 9] = buffer.colorR[i]!;
        data[base + 10] = buffer.colorG[i]!;
        data[base + 11] = buffer.colorB[i]!;
        data[base + 12] = buffer.colorA[i]!;
        savedSize[savedBase] = width;
        savedSize[savedBase + 1] = height;
    }

    for (let i = alive; i < previousCount; i++) {
        const savedBase = i * SAVED_SIZE_FLOATS_PER_SPRITE;
        savedSize[savedBase] = 0;
        savedSize[savedBase + 1] = 0;
    }

    _setSprite2DCount(layer, alive);
    const dirtyEnd = Math.max(previousCount, alive);
    if (dirtyEnd > 0) {
        _markSprite2DDirty(layer, 0, dirtyEnd);
    }
}

/**
 * Register a built NPE set with a pure-2D SpriteRenderer. Each system gets one
 * bridge-owned layer, starts by default, and advances/syncs in the renderer's own
 * update hook. Disposing the renderer automatically detaches the binding.
 */
export function registerNodeParticleSet2D(renderer: SpriteRenderer, set: NodeParticleSet, options: RegisterNodeParticleSet2DOptions = {}): NodeParticleSet2DBinding {
    // Build and sync every bridge before mutating the renderer. A bad texture or
    // sprite-sheet frame in a later system must not leave earlier layers attached
    // with no binding returned to dispose them.
    const bridges = set.systems.map((system) => createParticleSprite2DBridge(system, options));
    for (const bridge of bridges) {
        syncParticleSprite2DBridge(bridge);
    }

    let attached = 0;
    try {
        for (const bridge of bridges) {
            addSpriteRendererLayer(renderer, bridge.layer);
            attached++;
        }
    } catch (error) {
        while (attached > 0) {
            removeSpriteRendererLayer(renderer, bridges[--attached]!.layer);
        }
        throw error;
    }
    if (options.autoStart ?? true) {
        for (const bridge of bridges) {
            startParticleSystem(bridge.system);
        }
    }

    const hook = (deltaMs: number): void => {
        const ratio = deltaMs > 0 ? deltaMs / FRAME_MS : 1;
        for (const bridge of bridges) {
            animateParticleSystem(bridge.system, ratio);
            syncParticleSprite2DBridge(bridge);
        }
    };
    renderer._beforeUpdate.push(hook);

    const binding: NodeParticleSet2DBinding = {
        _entityType: "node-particle-set-2d-binding",
        bridges,
        active: true,
        _dispose: () => {
            const hookIndex = renderer._beforeUpdate.indexOf(hook);
            if (hookIndex !== -1) {
                renderer._beforeUpdate.splice(hookIndex, 1);
            }
            const callbackIndex = renderer._disposeCallbacks.indexOf(disposeWithRenderer);
            if (callbackIndex !== -1) {
                renderer._disposeCallbacks.splice(callbackIndex, 1);
            }
            for (const bridge of bridges) {
                removeSpriteRendererLayer(renderer, bridge.layer);
            }
        },
    };
    function disposeWithRenderer(): void {
        disposeNodeParticleSet2DBinding(binding);
    }
    renderer._disposeCallbacks.push(disposeWithRenderer);
    return binding;
}

/** Detach a renderer binding. Idempotent; particle simulation and textures remain caller-owned. */
export function disposeNodeParticleSet2DBinding(binding: NodeParticleSet2DBinding): void {
    if (!binding.active) {
        return;
    }
    binding.active = false;
    binding._dispose();
}
