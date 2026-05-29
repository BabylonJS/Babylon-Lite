import { describe, expect, it, vi } from "vitest";

import { createAnimationManager, updateAnimationManager } from "../../packages/babylon-lite/src/animation/animation-manager";
import type { EngineContextInternal } from "../../packages/babylon-lite/src/engine/engine";
import type { SceneContextInternal } from "../../packages/babylon-lite/src/scene/scene-core";
import type { SpriteAtlas } from "../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import { addBillboardSpriteIndex, createFacingBillboardSystem, removeBillboardSpriteIndex } from "../../packages/babylon-lite/src/sprite/billboard-sprite";
import { addBillboardSprite, isBillboardSpriteHandleAlive } from "../../packages/babylon-lite/src/sprite/billboard-sprite-handle";
import { playBillboardSpriteAnimation } from "../../packages/babylon-lite/src/sprite/billboard-sprite-handle-animation";
import { playBillboardSpriteIndexAnimation } from "../../packages/babylon-lite/src/sprite/billboard-sprite-index-animation";
import {
    addSpriteAnimation,
    attachSpriteAnimationsToRenderer,
    attachSpriteAnimationsToScene,
    clearSpriteAnimations,
    createSpriteAnimationManager,
    createSpriteFrameAnimation,
    disposeSpriteAnimationBinding,
    playSpriteFrameAnimation,
    removeSpriteAnimation,
    stopSpriteAnimation,
    updateSpriteAnimationManager,
} from "../../packages/babylon-lite/src/sprite/sprite-animation";
import {
    addSpriteAnimationManager,
    removeSpriteAnimationManager,
    startSpriteAnimationManager,
    stopSpriteAnimationManager,
} from "../../packages/babylon-lite/src/sprite/sprite-animation-task";
import type { SpriteFrameAnimation } from "../../packages/babylon-lite/src/sprite/sprite-animation";
import { addSprite2DIndex, createSprite2DLayer, removeSprite2DIndex, setSprite2DFrameIndex } from "../../packages/babylon-lite/src/sprite/sprite-2d";
import { addSprite2D, getSprite2DHandleIndex, isSprite2DHandleAlive } from "../../packages/babylon-lite/src/sprite/sprite-2d-handle";
import { playSprite2DAnimation } from "../../packages/babylon-lite/src/sprite/sprite-2d-handle-animation";
import { playSprite2DIndexAnimation } from "../../packages/babylon-lite/src/sprite/sprite-2d-index-animation";
import type { SpriteRenderer } from "../../packages/babylon-lite/src/sprite/sprite-renderer";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";

type SpriteAnimationTestRenderer = SpriteRenderer & {
    _beforeUpdate: Array<(deltaMs: number) => void>;
    _disposeCallbacks: Array<() => void>;
};

function makeMockAtlas(): SpriteAtlas {
    const texture = {
        texture: {} as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width: 256,
        height: 32,
    } satisfies Texture2D;
    return {
        texture,
        textureSizePx: [256, 32],
        frames: [
            { uvMin: [0, 0], uvMax: [0.125, 1], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
            { uvMin: [0.125, 0], uvMax: [0.25, 1], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
            { uvMin: [0.25, 0], uvMax: [0.375, 1], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
            { uvMin: [0.375, 0], uvMax: [0.5, 1], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
            { uvMin: [0.5, 0], uvMax: [0.625, 1], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
            { uvMin: [0.625, 0], uvMax: [0.75, 1], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
            { uvMin: [0.75, 0], uvMax: [0.875, 1], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
            { uvMin: [0.875, 0], uvMax: [1, 1], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
        ],
        premultipliedAlpha: false,
    };
}

function makeNonUniformAtlas(): SpriteAtlas {
    const atlas = makeMockAtlas();
    return {
        ...atlas,
        frames: [atlas.frames[0]!, { uvMin: [0.125, 0], uvMax: [0.375, 1], sourceSizePx: [64, 24], pivot: [0.5, 0.5] }, ...atlas.frames.slice(2)],
    };
}

function makeNarrowNonDegenerateAtlas(): SpriteAtlas {
    const atlas = makeMockAtlas();
    return {
        ...atlas,
        textureSizePx: [256, 32],
        frames: [
            { uvMin: [0, 0], uvMax: [1 / 256, 1], sourceSizePx: [1, 32], pivot: [0.5, 0.5] },
            { uvMin: [1 / 256, 0], uvMax: [2 / 256, 1], sourceSizePx: [1, 32], pivot: [0.5, 0.5] },
        ],
    };
}

function sprite2DUvMinX(layer: ReturnType<typeof createSprite2DLayer>, index = 0): number {
    return layer._instanceData[index * layer._instanceFloatsPerSprite + 4]!;
}

function sprite2DUvMaxX(layer: ReturnType<typeof createSprite2DLayer>, index = 0): number {
    return layer._instanceData[index * layer._instanceFloatsPerSprite + 6]!;
}

function billboardUvMinX(system: ReturnType<typeof createFacingBillboardSystem>, index = 0): number {
    return system._instanceData[index * system._instanceFloatsPerSprite + 5]!;
}

function makeSpriteAnimationScene(): SceneContextInternal {
    return {
        _beforeRender: [] as Array<(deltaMs: number) => void>,
        _disposables: [] as Array<() => void>,
    } as unknown as SceneContextInternal;
}

function spriteAnimationManagerBinding(manager: ReturnType<typeof createSpriteAnimationManager>): unknown {
    return (manager as { _binding?: unknown })._binding;
}

describe("SpriteAnimationManager", () => {
    it("adds, removes, clears, and stops animations without touching sprite family code", () => {
        const manager = createSpriteAnimationManager();
        const setFrame = vi.fn();
        const animation: SpriteFrameAnimation = {
            _entityType: "sprite-frame-animation",
            target: { setFrame },
            from: 0,
            to: 3,
            current: 0,
            loop: true,
            delayMs: 100,
            accumulatedMs: 0,
            animationStarted: true,
            removeWhenFinished: false,
        };

        addSpriteAnimation(manager, animation);
        addSpriteAnimation(manager, animation);
        expect(manager.animations).toEqual([animation]);

        stopSpriteAnimation(animation);
        updateSpriteAnimationManager(manager, 101);
        expect(setFrame).not.toHaveBeenCalled();
        expect(animation.animationStarted).toBe(false);

        removeSpriteAnimation(manager, animation);
        expect(manager.animations).toEqual([]);

        addSpriteAnimation(manager, animation);
        clearSpriteAnimations(manager);
        expect(manager.animations).toEqual([]);
    });

    it("moves animations between managers and clears ownership when finished", () => {
        const firstManager = createSpriteAnimationManager();
        const secondManager = createSpriteAnimationManager();
        const animation = createSpriteFrameAnimation({ setFrame: vi.fn() }, 0, 1, false, 50);

        addSpriteAnimation(firstManager, animation);
        addSpriteAnimation(secondManager, animation);

        expect(firstManager.animations).toEqual([]);
        expect(secondManager.animations).toEqual([animation]);

        updateSpriteAnimationManager(secondManager, 51);
        updateSpriteAnimationManager(secondManager, 51);

        expect(secondManager.animations).toEqual([]);
    });

    it("updates replay callback and removal options when provided", () => {
        const manager = createSpriteAnimationManager();
        const target = { setFrame: vi.fn(), remove: vi.fn() };
        const firstEnd = vi.fn();
        const secondEnd = vi.fn();
        const animation = createSpriteFrameAnimation(target, 0, 1, false, 50, { onEnd: firstEnd, removeWhenFinished: true });

        addSpriteAnimation(manager, animation);
        playSpriteFrameAnimation(animation, 0, 1, false, 50, { onEnd: secondEnd });
        updateSpriteAnimationManager(manager, 51);
        updateSpriteAnimationManager(manager, 51);

        expect(firstEnd).not.toHaveBeenCalled();
        expect(secondEnd).toHaveBeenCalledTimes(1);
        expect(target.remove).not.toHaveBeenCalled();

        playSpriteFrameAnimation(animation, 0, 1, false, 50, {});
        addSpriteAnimation(manager, animation);
        updateSpriteAnimationManager(manager, 51);
        updateSpriteAnimationManager(manager, 51);

        expect(secondEnd).toHaveBeenCalledTimes(1);
        expect(target.remove).not.toHaveBeenCalled();
    });

    it("rejects non-finite from/to when replaying", () => {
        const animation = createSpriteFrameAnimation({ setFrame: vi.fn() }, 0, 1, false, 50);

        expect(() => playSpriteFrameAnimation(animation, Infinity, 1)).toThrow(/finite from\/to/);
        expect(() => playSpriteFrameAnimation(animation, 0, NaN)).toThrow(/finite from\/to/);
        expect(animation.from).toBe(0);
        expect(animation.to).toBe(1);
        expect(animation.current).toBe(0);
    });

    it("removes the finished animation by identity when onEnd clears the manager", () => {
        const manager = createSpriteAnimationManager();
        const finished = createSpriteFrameAnimation({ setFrame: vi.fn() }, 0, 1, false, 50, {
            onEnd: () => clearSpriteAnimations(manager),
        });
        const other = createSpriteFrameAnimation({ setFrame: vi.fn() }, 0, 5, false, 50);

        addSpriteAnimation(manager, other);
        addSpriteAnimation(manager, finished);

        expect(() => {
            updateSpriteAnimationManager(manager, 51);
            updateSpriteAnimationManager(manager, 51);
        }).not.toThrow();

        expect(manager.animations).toEqual([]);
    });

    it("uses fixedDeltaMs when supplied", () => {
        const manager = createSpriteAnimationManager({ fixedDeltaMs: 51 });
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });
        playSprite2DIndexAnimation(manager, layer, 0, 0, 2, true, 50);

        updateSpriteAnimationManager(manager, 1);

        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.125);
    });

    it("can be driven by the generic AnimationManager task pipeline", () => {
        const animationManager = createAnimationManager();
        const spriteManager = createSpriteAnimationManager();
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });
        playSprite2DIndexAnimation(spriteManager, layer, 0, 0, 2, true, 50);

        addSpriteAnimationManager(animationManager, spriteManager);
        updateAnimationManager(animationManager, 51);

        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.125);

        removeSpriteAnimationManager(animationManager, spriteManager);
        updateAnimationManager(animationManager, 51);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.125);
    });
});

describe("Sprite2D index animation", () => {
    it("matches Babylon.js frame-delay semantics", () => {
        const manager = createSpriteAnimationManager();
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [100, 100], sizePx: [32, 32], frame: 0 });

        playSprite2DIndexAnimation(manager, layer, 0, 0, 3, true, 100);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0);

        updateSpriteAnimationManager(manager, 100);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0);

        updateSpriteAnimationManager(manager, 1);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.125);

        updateSpriteAnimationManager(manager, 500);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.25);
    });

    it("loops and supports reverse ranges", () => {
        const manager = createSpriteAnimationManager();
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });

        playSprite2DIndexAnimation(manager, layer, 0, 0, 2, true, 50);
        updateSpriteAnimationManager(manager, 51);
        updateSpriteAnimationManager(manager, 51);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.25);
        updateSpriteAnimationManager(manager, 51);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0);

        clearSpriteAnimations(manager);
        playSprite2DIndexAnimation(manager, layer, 0, 3, 0, false, 50);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.375);
        updateSpriteAnimationManager(manager, 51);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.25);
        updateSpriteAnimationManager(manager, 51);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.125);
        updateSpriteAnimationManager(manager, 51);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0);
        updateSpriteAnimationManager(manager, 51);
        expect(manager.animations).toEqual([]);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0);
    });

    it("preserves Sprite2D flip state when advancing frames", () => {
        const manager = createSpriteAnimationManager();
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0, flipX: true });

        expect(sprite2DUvMinX(layer)).toBeGreaterThan(sprite2DUvMaxX(layer));

        playSprite2DIndexAnimation(manager, layer, 0, 0, 2, true, 50);
        updateSpriteAnimationManager(manager, 51);

        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.25);
        expect(sprite2DUvMaxX(layer)).toBeCloseTo(0.125);
    });

    it("keeps explicit Sprite2D size when switching to a different-sized frame", () => {
        const layer = createSprite2DLayer(makeNonUniformAtlas());
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 40], frame: 0 });

        setSprite2DFrameIndex(layer, 0, 1);

        expect(layer._instanceData[2]).toBe(32);
        expect(layer._instanceData[3]).toBe(40);
        expect(layer._savedSize[0]).toBe(32);
        expect(layer._savedSize[1]).toBe(40);
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.125);
        expect(sprite2DUvMaxX(layer)).toBeCloseTo(0.375);
    });

    it("preserves Sprite2D flip state for narrow non-degenerate frames", () => {
        const layer = createSprite2DLayer(makeNarrowNonDegenerateAtlas());
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [1, 32], frame: 0, flipX: true });

        setSprite2DFrameIndex(layer, 0, 1);

        expect(sprite2DUvMinX(layer)).toBeGreaterThan(sprite2DUvMaxX(layer));
        expect(sprite2DUvMinX(layer)).toBeCloseTo(2 / 256);
        expect(sprite2DUvMaxX(layer)).toBeCloseTo(1 / 256);
    });

    it("fires end callback once and removes the index target when requested", () => {
        const manager = createSpriteAnimationManager();
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });
        const onEnd = vi.fn(() => {
            expect(layer.count).toBe(1);
        });

        playSprite2DIndexAnimation(manager, layer, 0, 0, 1, false, 50, { onEnd, removeWhenFinished: true });
        updateSpriteAnimationManager(manager, 51);
        updateSpriteAnimationManager(manager, 51);
        updateSpriteAnimationManager(manager, 51);

        expect(onEnd).toHaveBeenCalledTimes(1);
        expect(layer.count).toBe(0);
        expect(manager.animations).toEqual([]);
    });

    it("uses slot semantics after index swap-remove", () => {
        const manager = createSpriteAnimationManager();
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });
        addSprite2DIndex(layer, { positionPx: [32, 0], sizePx: [32, 32], frame: 0 });
        addSprite2DIndex(layer, { positionPx: [64, 0], sizePx: [32, 32], frame: 4 });

        playSprite2DIndexAnimation(manager, layer, 1, 0, 2, true, 50);
        removeSprite2DIndex(layer, 1);
        expect(sprite2DUvMinX(layer, 1)).toBeCloseTo(0.5);

        updateSpriteAnimationManager(manager, 51);

        expect(sprite2DUvMinX(layer, 1)).toBeCloseTo(0.125);
    });
});

describe("Sprite2D handle animation", () => {
    it("survives swap-removes through stable handles", () => {
        const manager = createSpriteAnimationManager();
        const layer = createSprite2DLayer(makeMockAtlas());
        const first = addSprite2D(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });
        const animated = addSprite2D(layer, { positionPx: [64, 0], sizePx: [32, 32], frame: 0 });
        addSprite2D(layer, { positionPx: [128, 0], sizePx: [32, 32], frame: 0 });

        playSprite2DAnimation(manager, animated, 0, 3, true, 50);
        removeSprite2DIndex(layer, 0);
        expect(isSprite2DHandleAlive(first)).toBe(false);

        updateSpriteAnimationManager(manager, 51);

        expect(sprite2DUvMinX(layer, getSprite2DHandleIndex(animated))).toBeCloseTo(0.125);
    });

    it("removes the handle target when requested", () => {
        const manager = createSpriteAnimationManager();
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test-write" });
        const handle = addSprite2D(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0, z: 0.6 });

        playSprite2DAnimation(manager, handle, 0, 1, false, 50, { removeWhenFinished: true });
        updateSpriteAnimationManager(manager, 51);
        updateSpriteAnimationManager(manager, 51);

        expect(layer.count).toBe(0);
        expect(isSprite2DHandleAlive(handle)).toBe(false);
    });
});

describe("Billboard sprite animation", () => {
    it("animates billboard frames by index", () => {
        const manager = createSpriteAnimationManager();
        const system = createFacingBillboardSystem(makeMockAtlas());
        addBillboardSpriteIndex(system, { position: [0, 0, 0], sizeWorld: [1, 1], frame: 0 });

        playBillboardSpriteIndexAnimation(manager, system, 0, 0, 3, true, 100);
        updateSpriteAnimationManager(manager, 101);

        expect(billboardUvMinX(system)).toBeCloseTo(0.125);
    });

    it("uses slot semantics for billboard index animations after swap-remove", () => {
        const manager = createSpriteAnimationManager();
        const system = createFacingBillboardSystem(makeMockAtlas());
        addBillboardSpriteIndex(system, { position: [0, 0, 0], sizeWorld: [1, 1], frame: 0 });
        addBillboardSpriteIndex(system, { position: [1, 0, 0], sizeWorld: [1, 1], frame: 0 });
        addBillboardSpriteIndex(system, { position: [2, 0, 0], sizeWorld: [1, 1], frame: 4 });

        playBillboardSpriteIndexAnimation(manager, system, 1, 0, 2, true, 50);
        removeBillboardSpriteIndex(system, 1);
        expect(billboardUvMinX(system, 1)).toBeCloseTo(0.5);

        updateSpriteAnimationManager(manager, 51);

        expect(billboardUvMinX(system, 1)).toBeCloseTo(0.125);
    });

    it("animates and removes billboard handle targets", () => {
        const manager = createSpriteAnimationManager();
        const system = createFacingBillboardSystem(makeMockAtlas());
        const handle = addBillboardSprite(system, { position: [0, 0, 0], sizeWorld: [1, 1], frame: 0 });

        playBillboardSpriteAnimation(manager, handle, 0, 1, false, 50, { removeWhenFinished: true });
        updateSpriteAnimationManager(manager, 51);
        updateSpriteAnimationManager(manager, 51);

        expect(system.count).toBe(0);
        expect(isBillboardSpriteHandleAlive(handle)).toBe(false);
    });
});

describe("sprite animation render-loop attachments", () => {
    it("attaches to scenes using the actual before-render delta", () => {
        const manager = createSpriteAnimationManager();
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });
        playSprite2DIndexAnimation(manager, layer, 0, 0, 3, true, 50);
        const scene = makeSpriteAnimationScene();

        const binding = attachSpriteAnimationsToScene(scene, manager);
        scene._beforeRender[0]!(51);

        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.125);
        disposeSpriteAnimationBinding(binding);
        expect(scene._beforeRender).toEqual([]);
        expect(spriteAnimationManagerBinding(manager)).toBeUndefined();
    });

    it("registers scene disposal cleanup for scene attachments", () => {
        const manager = createSpriteAnimationManager();
        const scene = makeSpriteAnimationScene();

        const binding = attachSpriteAnimationsToScene(scene, manager);
        for (const dispose of scene._disposables) {
            dispose();
        }
        scene._beforeRender.length = 0;

        expect(binding.active).toBe(false);
        expect(spriteAnimationManagerBinding(manager)).toBeUndefined();
        const nextBinding = attachSpriteAnimationsToScene(makeSpriteAnimationScene(), manager);
        expect(nextBinding.active).toBe(true);
        disposeSpriteAnimationBinding(nextBinding);
    });

    it("attaches to renderers before upload using engine current delta", () => {
        const manager = createSpriteAnimationManager();
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });
        playSprite2DIndexAnimation(manager, layer, 0, 0, 3, true, 50);
        let frameSeenByUpload = -1;
        const renderer = {
            _engine: { _currentDelta: 51 } as EngineContextInternal,
            _beforeUpdate: [] as Array<(deltaMs: number) => void>,
            _disposeCallbacks: [] as Array<() => void>,
            _update(): void {
                for (const hook of this._beforeUpdate) {
                    hook(this._engine._currentDelta);
                }
                frameSeenByUpload = sprite2DUvMinX(layer);
            },
        } as unknown as SpriteAnimationTestRenderer;

        const binding = attachSpriteAnimationsToRenderer(renderer, manager);
        renderer._update();

        expect(frameSeenByUpload).toBeCloseTo(0.125);
        disposeSpriteAnimationBinding(binding);
        expect(spriteAnimationManagerBinding(manager)).toBeUndefined();
        expect(renderer._disposeCallbacks).toEqual([]);
        (renderer as unknown as { _engine: { _currentDelta: number } })._engine._currentDelta = 51;
        renderer._update();
        expect(sprite2DUvMinX(layer)).toBeCloseTo(0.125);
    });

    it("registers renderer disposal cleanup for renderer attachments", () => {
        const manager = createSpriteAnimationManager();
        const renderer = {
            _beforeUpdate: [] as Array<(deltaMs: number) => void>,
            _disposeCallbacks: [] as Array<() => void>,
        } as unknown as SpriteAnimationTestRenderer;

        const binding = attachSpriteAnimationsToRenderer(renderer, manager);
        for (const dispose of renderer._disposeCallbacks.slice()) {
            dispose();
        }
        renderer._beforeUpdate.length = 0;

        expect(binding.active).toBe(false);
        expect(renderer._disposeCallbacks).toEqual([]);
        expect(spriteAnimationManagerBinding(manager)).toBeUndefined();
        const nextBinding = attachSpriteAnimationsToRenderer({ _beforeUpdate: [], _disposeCallbacks: [] } as unknown as SpriteAnimationTestRenderer, manager);
        expect(nextBinding.active).toBe(true);
        disposeSpriteAnimationBinding(nextBinding);
    });

    it("composes renderer hooks and disposes them independently", () => {
        const firstManager = createSpriteAnimationManager();
        const firstLayer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(firstLayer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });
        playSprite2DIndexAnimation(firstManager, firstLayer, 0, 0, 3, true, 50);

        const secondManager = createSpriteAnimationManager();
        const secondLayer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(secondLayer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });
        playSprite2DIndexAnimation(secondManager, secondLayer, 0, 0, 3, true, 50);

        const renderer = {
            _engine: { _currentDelta: 51 } as EngineContextInternal,
            _beforeUpdate: [] as Array<(deltaMs: number) => void>,
            _disposeCallbacks: [] as Array<() => void>,
            _update(): void {
                for (const hook of this._beforeUpdate) {
                    hook(this._engine._currentDelta);
                }
            },
        } as unknown as SpriteAnimationTestRenderer;

        const firstBinding = attachSpriteAnimationsToRenderer(renderer, firstManager);
        const secondBinding = attachSpriteAnimationsToRenderer(renderer, secondManager);
        expect(renderer._beforeUpdate).toHaveLength(2);

        disposeSpriteAnimationBinding(firstBinding);
        expect(renderer._beforeUpdate).toHaveLength(1);
        expect(renderer._disposeCallbacks).toHaveLength(1);
        renderer._update();

        expect(sprite2DUvMinX(firstLayer)).toBeCloseTo(0);
        expect(sprite2DUvMinX(secondLayer)).toBeCloseTo(0.125);

        disposeSpriteAnimationBinding(secondBinding);
        expect(renderer._beforeUpdate).toEqual([]);
        expect(renderer._disposeCallbacks).toEqual([]);
    });

    it("prevents double attachment for one manager", () => {
        const manager = createSpriteAnimationManager();
        const scene = makeSpriteAnimationScene();
        attachSpriteAnimationsToScene(scene, manager);

        expect(() => attachSpriteAnimationsToScene(scene, manager)).toThrow(/already attached/);
    });

    it("prevents autonomous start while attached to a scene", () => {
        const manager = createSpriteAnimationManager();
        const scene = makeSpriteAnimationScene();
        attachSpriteAnimationsToScene(scene, manager);

        expect(() => startSpriteAnimationManager(manager)).toThrow(/already attached/);
    });

    it("prevents render-loop attachment while running autonomously", () => {
        vi.stubGlobal(
            "requestAnimationFrame",
            vi.fn(() => 1)
        );
        vi.stubGlobal("cancelAnimationFrame", vi.fn());
        const manager = createSpriteAnimationManager();
        const scene = makeSpriteAnimationScene();

        try {
            startSpriteAnimationManager(manager);

            expect(() => attachSpriteAnimationsToScene(scene, manager)).toThrow(/already running/);
        } finally {
            stopSpriteAnimationManager(manager);
            vi.unstubAllGlobals();
        }
    });
});
