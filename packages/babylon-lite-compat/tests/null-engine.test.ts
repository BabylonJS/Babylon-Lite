import { describe, expect, it, vi } from "vitest";

import { NullEngine, WebGPUEngine, AbstractEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";
import { Animatable, Animation, AnimationKeyInterpolation } from "../src/animations/animation";
import { CubicEase, QuadraticEase } from "../src/animations/easing";
import { Color3, Color4 } from "../src/math/color";
import { Quaternion } from "../src/math/quaternion";
import { Vector2, Vector3 } from "../src/math/vector";
import { LiteCompatError } from "../src/error";
import { MeshBuilder } from "../src/meshes/meshes";
import { stepScene } from "babylon-lite";

/**
 * The headless `NullEngine` runs scene logic with no GPU device — a deviceless
 * engine whose `Scene` skips the Lite scene-context build and ticks CPU animations
 * via the engine's pure-JS loop. These tests exercise that path GPU-free, mirroring
 * Babylon.js's `NullEngine` (used for server-side / test animation evaluation).
 */
describe("NullEngine (headless)", () => {
    it("is a flagged, immediately-usable engine in the BJS hierarchy", () => {
        const engine = new NullEngine();
        expect(engine).toBeInstanceOf(WebGPUEngine);
        expect(engine).toBeInstanceOf(AbstractEngine);
        expect(engine._headless).toBe(true);
        expect(engine.isWebGPU).toBe(true);
    });

    it("reports headless sample count and rejects engine-wide alpha-to-coverage state", () => {
        const engine = new NullEngine();
        expect(engine.currentSampleCount).toBe(1);
        expect(() => engine.getAlphaToCoverage()).toThrow(LiteCompatError);
        expect(() => engine.getAlphaToCoverage()).toThrow(/getAlphaToCoverage/);
        expect(() => engine.setAlphaToCoverage(true)).toThrow(LiteCompatError);
        expect(() => engine.setAlphaToCoverage(true)).toThrow(/setAlphaToCoverage/);
    });

    it("constructs a Scene with no GPU context", () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        expect(scene.getEngine()).toBe(engine);
        // The headless scene tracks no Lite render context, but its entity
        // registries and animation surface still work.
        expect(scene.cameras).toEqual([]);
        expect(scene.dispose()).toBeUndefined();
    });

    it("backs the scene with a real Lite context (no frame-graph render task)", () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        // The scene is a genuine Lite SceneContext (device-less), not a stub: it owns a
        // frame graph and a before-render callback list, so Lite drives the simulation.
        expect(scene._lite.surface).toBe(engine._lite);
        expect(Array.isArray(scene._lite._beforeRender)).toBe(true);
        expect(scene._lite._beforeRender.length).toBeGreaterThan(0);
        // `defaultRenderTask: false` → no render task was appended to the frame graph.
        expect(scene._lite._frameGraph._tasks.length).toBe(0);
        scene.dispose();
    });

    it("forwards independent box dimensions to Babylon Lite", () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        (engine._lite as unknown as { _device: GPUDevice })._device = {
            createBuffer: ({ size }: GPUBufferDescriptor) => {
                const mapped = new ArrayBuffer(Number(size));
                return {
                    getMappedRange: () => mapped,
                    unmap: () => undefined,
                    destroy: () => undefined,
                } as unknown as GPUBuffer;
            },
        } as unknown as GPUDevice;
        const box = MeshBuilder.CreateBox("panel", { width: 598, height: 18, depth: 530 }, scene);
        const bounds = box.getBoundingInfo();

        expect(bounds.minimum.asArray()).toEqual([-299, -9, -265]);
        expect(bounds.maximum.asArray()).toEqual([299, 9, 265]);
        scene.dispose();
    });

    it("fires onBeforeRenderObservable when Lite steps the headless scene", () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        let fired = 0;
        let seenDelta = 0;
        scene.onBeforeRenderObservable.add(() => {
            fired++;
            seenDelta = engine.getDeltaTime();
        });
        // Advancing via Lite's `stepScene` (what `runRenderLoop` calls per frame) must
        // run the scene's before-render callbacks — proving the simulation is Lite-driven.
        stepScene(engine._lite, scene._lite, 32);
        stepScene(engine._lite, scene._lite, 32);
        expect(fired).toBe(2);
        expect(seenDelta).toBe(32);
        scene.dispose();
    });

    it("defaults clearColor alpha to 1 when assigned a Color3", () => {
        const scene = new Scene(new NullEngine());
        // Babylon.js accepts a Color3 for clearColor; alpha must default to 1 so the
        // value reaching WebGPU's render pass is never `undefined`.
        scene.clearColor = new Color3(0.1, 0.2, 0.3) as unknown as Color4;
        expect(scene._lite.clearColor).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
        // An explicit Color4 alpha is preserved.
        scene.clearColor = new Color4(0.4, 0.5, 0.6, 0.7);
        expect(scene._lite.clearColor).toEqual({ r: 0.4, g: 0.5, b: 0.6, a: 0.7 });
    });

    it("delegates a supported direct animation to Lite for timing, easing, sampling, and writes", () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const target = { position: { x: -2 } };

        const slide = new Animation("slide", "position.x", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
        slide.setKeys([
            { frame: 0, value: -2 },
            { frame: 10, value: 2 },
            { frame: 20, value: -2 },
        ]);
        slide.setEasingFunction(new QuadraticEase());
        const compatEvaluate = vi.spyOn(slide, "evaluate");
        const animatable = scene.beginDirectAnimation(target, [slide], 0, 20, true);
        expect(animatable._lite).toBeDefined();
        expect(animatable._nativeFallbackReason).toBeUndefined();

        // Seeking applies the evaluated value synchronously (no render loop needed).
        animatable.goToFrame(5);
        expect(target.position.x).toBeCloseTo(-1, 6);
        animatable.goToFrame(10);
        expect(target.position.x).toBeCloseTo(2, 6);

        // A manual tick advances the running animation on the CPU.
        animatable.goToFrame(0);
        animatable.restart();
        target.position.x = -2;
        scene._tick(500); // 0.5s @ 10fps = 5 frames → quadratic ease-in to -1
        expect(target.position.x).toBeCloseTo(-1, 6);
        expect(compatEvaluate).not.toHaveBeenCalled();
    });

    it("preserves the public six-argument Animatable constructor", () => {
        const target = { x: 0 };
        const animation = new Animation("direct", "x", 10);
        animation.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);

        const animatable = new Animatable(target, [animation], 0, 10, false, 1);
        animatable._tick(500);

        expect(animatable.masterFrame).toBe(5);
        expect(target.x).toBe(5);
    });

    it("uses the explicit compat fallback for mixed per-key interpolation", () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const target = { position: { x: -2 } };
        const slide = new Animation("mixed", "position.x", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
        slide.setKeys([
            { frame: 0, value: -2, interpolation: 1 },
            { frame: 10, value: 2 },
            { frame: 20, value: -2 },
        ]);
        const compatEvaluate = vi.spyOn(slide, "evaluate");

        const animatable = scene.beginAnimation({ animations: [slide], ...target }, 0, 20, true);
        expect(animatable._lite).toBeUndefined();
        expect(animatable._nativeFallbackReason).toMatch(/mixes STEP and LINEAR/);

        scene._tick(500);
        expect(compatEvaluate).toHaveBeenCalled();
        expect(target.position.x).toBe(-2);
    });

    it("delegates attached Vector2, Vector3, and Quaternion animations to Lite", () => {
        const scene = new Scene(new NullEngine());
        const target = {
            uv: new Vector2(),
            position: new Vector3(),
            rotationQuaternion: new Quaternion(),
            animations: [] as Animation[],
        };
        const uv = new Animation("uv", "uv", 10, Animation.ANIMATIONTYPE_VECTOR2);
        uv.setKeys([
            { frame: 0, value: new Vector2(0, 0) },
            { frame: 10, value: new Vector2(4, 8) },
        ]);
        const position = new Animation("position", "position", 10, Animation.ANIMATIONTYPE_VECTOR3);
        position.setKeys([
            { frame: 0, value: new Vector3(0, 0, 0) },
            { frame: 10, value: new Vector3(4, 8, 12) },
        ]);
        const rotation = new Animation("rotation", "rotationQuaternion", 10, Animation.ANIMATIONTYPE_QUATERNION);
        rotation.setKeys([
            { frame: 0, value: new Quaternion(0, 0, 0, 1) },
            { frame: 10, value: new Quaternion(0, 0, 1, 0) },
        ]);
        for (const animation of [uv, position, rotation]) {
            animation.setEasingFunction(new QuadraticEase());
        }
        target.animations.push(uv, position, rotation);
        const compatEvaluators = target.animations.map((animation) => vi.spyOn(animation, "evaluate"));

        const animatable = scene.beginAnimation(target, 0, 10, false);
        scene._tick(500);

        expect(animatable._lite).toBeDefined();
        expect(target.uv.asArray()).toEqual([1, 2]);
        expect(target.position.asArray()).toEqual([1, 2, 3]);
        expect(target.rotationQuaternion.z).toBeCloseTo(Math.sin(Math.PI / 8), 6);
        expect(target.rotationQuaternion.w).toBeCloseTo(Math.cos(Math.PI / 8), 6);
        for (const evaluate of compatEvaluators) {
            expect(evaluate).not.toHaveBeenCalled();
        }
    });

    it("follows replaced vector and quaternion property objects during native playback", () => {
        const scene = new Scene(new NullEngine());
        const target = {
            position: new Vector3(),
            rotationQuaternion: new Quaternion(),
        };
        const position = new Animation("position", "position", 10, Animation.ANIMATIONTYPE_VECTOR3);
        position.setKeys([
            { frame: 0, value: new Vector3(0, 0, 0) },
            { frame: 10, value: new Vector3(10, 20, 30) },
        ]);
        const rotation = new Animation("rotation", "rotationQuaternion", 10, Animation.ANIMATIONTYPE_QUATERNION);
        rotation.setKeys([
            { frame: 0, value: new Quaternion(0, 0, 0, 1) },
            { frame: 10, value: new Quaternion(0, 0, 1, 0) },
        ]);

        scene.beginDirectAnimation(target, [position, rotation], 0, 10, false);
        scene._tick(250);
        const replacedPosition = new Vector3(100, 100, 100);
        const replacedRotation = new Quaternion(1, 0, 0, 0);
        target.position = replacedPosition;
        target.rotationQuaternion = replacedRotation;

        scene._tick(250);

        expect(target.position).toBe(replacedPosition);
        expect(target.position.asArray()).toEqual([5, 10, 15]);
        expect(target.rotationQuaternion).toBe(replacedRotation);
        expect(target.rotationQuaternion.z).toBeCloseTo(Math.SQRT1_2, 6);
        expect(target.rotationQuaternion.w).toBeCloseTo(Math.SQRT1_2, 6);
    });

    it("observes easing replacement and clearing during native playback", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0 };
        const animation = new Animation("liveEasing", "x", 10);
        animation.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        animation.setEasingFunction(new QuadraticEase());
        scene.beginDirectAnimation(target, [animation], 0, 10, false);

        animation.setEasingFunction(new CubicEase());
        scene._tick(500);
        expect(target.x).toBeCloseTo(1.25);

        animation.setEasingFunction(null);
        scene._tick(0);
        expect(target.x).toBeCloseTo(5);
    });

    it("applies easing through the explicit compat fallback", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0 };
        const animation = new Animation("fallbackEasing", "x", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
        animation.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        animation.setEasingFunction(new QuadraticEase());
        const evaluate = vi.spyOn(animation, "evaluate");
        const animatable = scene.beginDirectAnimation(target, [animation], 0, 10, false);

        scene._tick(500);

        expect(animatable._lite).toBeUndefined();
        expect(animatable._nativeFallbackReason).toMatch(/cycle loop mode/);
        expect(evaluate).toHaveBeenCalled();
        expect(target.x).toBeCloseTo(2.5);
    });

    it("keeps supported tracks native in a mixed supported/fallback call", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0, y: 0 };
        const supported = new Animation("supported", "x", 10);
        supported.setKeys([
            { frame: 0, value: 0 },
            { frame: 20, value: 20 },
        ]);
        const unsupported = new Animation("unsupported", "y", 10);
        unsupported.setKeys([
            { frame: 0, value: 0, interpolation: AnimationKeyInterpolation.STEP },
            { frame: 10, value: 10 },
            { frame: 20, value: 20 },
        ]);
        const supportedEvaluate = vi.spyOn(supported, "evaluate");
        const unsupportedEvaluate = vi.spyOn(unsupported, "evaluate");

        const animatable = scene.beginDirectAnimation(target, [supported, unsupported], 0, 20, true);
        scene._tick(500);

        expect(animatable._lite).toBeDefined();
        expect(animatable._nativeFallbackReason).toMatch(/mixes STEP and LINEAR/);
        expect(supportedEvaluate).not.toHaveBeenCalled();
        expect(unsupportedEvaluate).toHaveBeenCalled();
        expect(target).toEqual({ x: 5, y: 0 });
    });

    it("seeks native and fallback tracks within their own key domains", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0, y: 0 };
        const fallback = new Animation("shortFallback", "x", 10);
        fallback.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const native = new Animation("longNative", "y", 10);
        native.setKeys([
            { frame: 0, value: 0 },
            { frame: 20, value: 20 },
        ]);

        const animatable = scene.beginDirectAnimation(target, [fallback, native], 0, 20, false);
        expect(animatable._lite).toBeDefined();
        expect(animatable._nativeFallbackReason).toMatch(/does not cover/);

        animatable.goToFrame(15);

        expect(animatable.masterFrame).toBe(15);
        expect(target).toEqual({ x: 10, y: 15 });
    });

    it("preserves supported track order for overlapping native writes", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0 };
        const first = new Animation("first", "x", 10);
        first.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const second = new Animation("second", "x", 10);
        second.setKeys([
            { frame: 0, value: 100 },
            { frame: 10, value: 200 },
        ]);

        const animatable = scene.beginDirectAnimation(target, [first, second], 0, 10, false);
        scene._tick(500);

        expect(animatable._lite).toBeDefined();
        expect(target.x).toBeCloseTo(150);
    });

    it("preserves native write precedence when an older group pauses and restarts", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0 };
        const olderAnimation = new Animation("older", "x", 10);
        olderAnimation.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const newerAnimation = new Animation("newer", "x", 10);
        newerAnimation.setKeys([
            { frame: 0, value: 100 },
            { frame: 10, value: 200 },
        ]);

        const older = scene.beginDirectAnimation(target, [olderAnimation], 0, 10, false);
        older.pause();
        scene.beginDirectAnimation(target, [newerAnimation], 0, 10, false);
        older.restart();
        scene._tick(500);

        expect(target.x).toBeCloseTo(150);
    });

    it("preserves write order for aliased bindings and stopped fallback restarts", () => {
        const scene = new Scene(new NullEngine());
        const shared = { x: 0 };
        const fallbackTarget = { nested: shared };
        const nativeTarget = shared;
        const olderFallback = new Animation("olderFallback", "nested.x", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
        olderFallback.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const newer = new Animation("newer", "x", 10);
        newer.setKeys([
            { frame: 0, value: 100 },
            { frame: 10, value: 200 },
        ]);

        const older = scene.beginDirectAnimation(fallbackTarget, [olderFallback], 0, 10, false);
        older.stop();
        const newerAnimatable = scene.beginDirectAnimation(nativeTarget, [newer], 0, 10, false);
        expect(newerAnimatable._lite).toBeUndefined();
        expect(newerAnimatable._nativeFallbackReason).toMatch(/overlaps a compat fallback path/);

        older.restart();
        scene._tick(500);

        expect(shared.x).toBeCloseTo(150);
    });

    it("keeps a later overlapping track on fallback when an earlier fallback owns the path", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0 };
        const first = new Animation("fallbackFirst", "x", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
        first.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const second = new Animation("supportedSecond", "x", 10);
        second.setKeys([
            { frame: 0, value: 100 },
            { frame: 10, value: 200 },
        ]);
        scene.beginDirectAnimation(target, [first], 0, 10, false);
        const secondAnimatable = scene.beginDirectAnimation(target, [second], 0, 10, false);

        scene._tick(500);

        expect(secondAnimatable._lite).toBeUndefined();
        expect(secondAnimatable._nativeFallbackReason).toMatch(/overlaps a compat fallback path/);
        expect(target.x).toBeCloseTo(150);
    });

    it("plays reverse ranges and negative speed through explicit fallback", () => {
        const animation = new Animation("reverse", "x", 10);
        animation.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);

        const reverseScene = new Scene(new NullEngine());
        const reverseTarget = { x: 0 };
        const reverseRange = reverseScene.beginDirectAnimation(reverseTarget, [animation], 10, 0, false);
        expect(reverseRange._lite).toBeUndefined();
        expect(reverseRange._nativeFallbackReason).toMatch(/forward play range/);
        expect(reverseTarget.x).toBe(10);
        reverseScene._tick(500);
        expect(reverseRange.masterFrame).toBe(5);
        expect(reverseTarget.x).toBe(5);
        reverseScene._tick(500);
        expect(reverseRange.masterFrame).toBe(0);
        expect(reverseTarget.x).toBe(0);
        expect(reverseRange.animationStarted).toBe(false);

        const negativeScene = new Scene(new NullEngine());
        const negativeTarget = { x: 0, animations: [animation] };
        const negativeSpeed = negativeScene.beginAnimation(negativeTarget, 0, 10, false, -1);
        expect(negativeSpeed._lite).toBeUndefined();
        expect(negativeTarget.x).toBe(10);
        negativeScene._tick(500);
        expect(negativeSpeed.masterFrame).toBe(5);
        expect(negativeTarget.x).toBe(5);

        const loopingScene = new Scene(new NullEngine());
        const loopingTarget = { x: 0 };
        const loopingReverse = loopingScene.beginDirectAnimation(loopingTarget, [animation], 10, 0, true);
        loopingScene._tick(1000);
        expect(loopingReverse.masterFrame).toBe(10);
        expect(loopingTarget.x).toBe(10);
        expect(loopingReverse.animationStarted).toBe(true);
        loopingScene._tick(500);
        expect(loopingReverse.masterFrame).toBe(5);
        expect(loopingTarget.x).toBe(5);
    });

    it("evaluates mixed-FPS fallback tracks on their own clocks", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0, y: 0 };
        const fast = new Animation("fast", "x", 20);
        fast.setKeys([
            { frame: 0, value: 0 },
            { frame: 20, value: 20 },
        ]);
        const slow = new Animation("slow", "y", 10);
        slow.setKeys([
            { frame: 0, value: 0 },
            { frame: 20, value: 20 },
        ]);

        const animatable = scene.beginDirectAnimation(target, [fast, slow], 0, 20, false);
        expect(animatable._lite).toBeUndefined();
        expect(animatable._nativeFallbackReason).toMatch(/shared frame rate/);
        scene._tick(500);
        expect(animatable.masterFrame).toBe(10);
        expect(target).toEqual({ x: 10, y: 5 });
        scene._tick(500);
        expect(animatable.masterFrame).toBe(20);
        expect(target).toEqual({ x: 20, y: 10 });
        expect(animatable.animationStarted).toBe(true);
        scene._tick(1000);
        expect(target).toEqual({ x: 20, y: 20 });
        expect(animatable.animationStarted).toBe(false);
    });

    it("preserves constant and relative loop modes on fallback tracks", () => {
        const scene = new Scene(new NullEngine());
        const target = { constant: 0, relative: 0, native: 0 };
        const constant = new Animation("constant", "constant", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
        constant.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const relative = new Animation("relative", "relative", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_RELATIVE);
        relative.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const native = new Animation("native", "native", 10);
        native.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const animatable = scene.beginDirectAnimation(target, [constant, relative, native], 0, 10, true);
        expect(animatable._lite).toBeDefined();

        scene._tick(1000);
        expect(animatable.animationStarted).toBe(true);
        expect(target).toEqual({ constant: 10, relative: 10, native: 0 });
        scene._tick(500);
        expect(target).toEqual({ constant: 10, relative: 15, native: 5 });
        scene._tick(1000);
        expect(target).toEqual({ constant: 10, relative: 25, native: 5 });
    });

    it("matches Babylon.js near-parallel quaternion slerp on native playback", () => {
        const scene = new Scene(new NullEngine());
        const target = { rotationQuaternion: new Quaternion() };
        const animation = new Animation("nearParallel", "rotationQuaternion", 10, Animation.ANIMATIONTYPE_QUATERNION);
        animation.setEasingFunction({ ease: () => 1.25 });
        animation.setKeys([
            { frame: 0, value: new Quaternion(0, 0, 0, 1) },
            { frame: 10, value: new Quaternion(0, 0, 0.015, Math.sqrt(1 - 0.015 * 0.015)) },
        ]);

        const animatable = scene.beginDirectAnimation(target, [animation], 0, 10, false);
        scene._tick(500);

        expect(animatable._lite).toBeDefined();
        expect(target.rotationQuaternion.z).toBeCloseTo(0.018749604459090463, 8);
        expect(target.rotationQuaternion.w).toBeCloseTo(0.9998241662979126, 8);
    });

    it("detaches paused, stopped, completed, and disposed native groups", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0 };
        const animation = new Animation("ownership", "x", 10);
        animation.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const animatable = scene.beginDirectAnimation(target, [animation], 0, 10, false);
        const manager = (scene as unknown as { _propertyAnimationManager: { animations: unknown[] } })._propertyAnimationManager;
        expect(manager.animations).toHaveLength(1);

        scene._tick(500);
        animatable.pause();
        expect(manager.animations).toHaveLength(0);
        target.x = 99;
        scene._tick(100);
        expect(target.x).toBe(99);

        animatable.restart();
        expect(manager.animations).toHaveLength(1);
        scene._tick(500);
        expect(animatable.animationStarted).toBe(false);
        expect(manager.animations).toHaveLength(0);

        animatable.restart();
        expect(manager.animations).toHaveLength(1);
        animatable.stop();
        expect(manager.animations).toHaveLength(0);

        animatable.restart();
        expect(manager.animations).toHaveLength(1);
        scene.dispose();
        expect(manager.animations).toHaveLength(0);
    });

    it("waits for mixed fallback completion and trusts native completion state", () => {
        const mixedScene = new Scene(new NullEngine());
        const mixedTarget = { x: 0, y: 0 };
        const native = new Animation("native", "x", 10);
        native.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const fallback = new Animation("fallback", "y", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
        fallback.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const mixed = mixedScene.beginDirectAnimation(mixedTarget, [native, fallback], 0, 10, false);
        fallback.framePerSecond = 5;

        mixedScene._tick(1000);
        expect(mixed.animationStarted).toBe(true);
        expect(mixedTarget).toEqual({ x: 10, y: 5 });
        mixedScene._tick(1000);
        expect(mixed.animationStarted).toBe(false);
        expect(mixedTarget).toEqual({ x: 10, y: 10 });

        const fractionalScene = new Scene(new NullEngine());
        const fractionalTarget = { x: 0 };
        const fractional = new Animation("fractional", "x", 60);
        fractional.setKeys([
            { frame: 0, value: 0 },
            { frame: 123, value: 123 },
        ]);
        const fractionalAnimatable = fractionalScene.beginDirectAnimation(fractionalTarget, [fractional], 0, 123, false);
        fractionalScene._tick(2050);
        expect(fractionalAnimatable.animationStarted).toBe(false);
        expect(fractionalTarget.x).toBe(123);
    });

    it("applies the final STEP key at a non-exact frame-derived end time", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0 };
        const animation = new Animation("step", "x", 60);
        animation.setKeys([
            { frame: 0, value: 0, interpolation: AnimationKeyInterpolation.STEP },
            { frame: 1, value: 10 },
        ]);

        const animatable = scene.beginDirectAnimation(target, [animation], 0, 1, false);
        scene._tick(1000 / 60);

        expect(animatable.animationStarted).toBe(false);
        expect(target.x).toBe(10);
    });

    it("pauses mixed native and fallback tracks without rewriting external changes", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0, y: 0 };
        const native = new Animation("native", "x", 10);
        native.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        const fallback = new Animation("fallback", "y", 10);
        fallback.setKeys([
            { frame: 0, value: 0, interpolation: AnimationKeyInterpolation.STEP },
            { frame: 5, value: 5 },
            { frame: 10, value: 10 },
        ]);
        const animatable = scene.beginDirectAnimation(target, [native, fallback], 0, 10, false);
        scene._tick(500);
        expect(target).toEqual({ x: 5, y: 5 });

        animatable.pause();
        target.x = 100;
        target.y = 200;
        scene._tick(100);
        expect(target).toEqual({ x: 100, y: 200 });

        animatable.goToFrame(7);
        expect(target).toEqual({ x: 7, y: 7 });
    });

    it("preserves nonzero ranges, exact loop boundaries, and non-loop completion", () => {
        const loopingScene = new Scene(new NullEngine());
        const loopingTarget = { x: 0 };
        const looping = new Animation("looping", "x", 10);
        looping.setKeys([
            { frame: 0, value: 0 },
            { frame: 20, value: 20 },
        ]);
        const loopingAnimatable = loopingScene.beginDirectAnimation(loopingTarget, [looping], 5, 15, true);
        loopingScene._tick(1000);
        expect(loopingAnimatable.masterFrame).toBeCloseTo(5);
        expect(loopingTarget.x).toBeCloseTo(5);

        const finiteScene = new Scene(new NullEngine());
        const finiteTarget = { x: 0 };
        const finite = new Animation("finite", "x", 10);
        finite.setKeys([
            { frame: 0, value: 0 },
            { frame: 20, value: 20 },
        ]);
        const finiteAnimatable = finiteScene.beginDirectAnimation(finiteTarget, [finite], 5, 15, false);
        finiteScene._tick(1000);
        expect(finiteAnimatable.masterFrame).toBeCloseTo(15);
        expect(finiteAnimatable.animationStarted).toBe(false);
        expect(finiteTarget.x).toBeCloseTo(15);
        finiteTarget.x = 99;
        finiteScene._tick(100);
        expect(finiteTarget.x).toBe(99);
    });

    it("coordinates pause, restart, stop, seek, and positive speed changes", () => {
        const scene = new Scene(new NullEngine());
        const target = { x: 0 };
        const animation = new Animation("lifecycle", "x", 10);
        animation.setKeys([
            { frame: 0, value: 0 },
            { frame: 20, value: 20 },
        ]);
        const animatable = scene.beginDirectAnimation(target, [animation], 5, 15, false);

        scene._tick(250);
        expect(animatable.masterFrame).toBeCloseTo(7.5);
        animatable.pause();
        expect(animatable.animationStarted).toBe(false);
        scene._tick(250);
        expect(animatable.masterFrame).toBeCloseTo(7.5);

        animatable.restart();
        expect(animatable.animationStarted).toBe(true);
        animatable.speedRatio = 2;
        scene._tick(125);
        expect(animatable.masterFrame).toBeCloseTo(10);
        expect(target.x).toBeCloseTo(10);
        expect(() => {
            animatable.speedRatio = -1;
        }).toThrow(/non-negative/);

        animatable.goToFrame(2);
        expect(animatable.masterFrame).toBe(2);
        expect(target.x).toBeCloseTo(2);
        animatable.goToFrame(-5);
        expect(animatable.masterFrame).toBe(0);
        expect(target.x).toBeCloseTo(0);
        animatable.goToFrame(25);
        expect(animatable.masterFrame).toBe(20);
        expect(target.x).toBeCloseTo(20);

        animatable.stop();
        target.x = 99;
        scene._tick(100);
        expect(target.x).toBe(99);
        animatable.restart();
        expect(animatable.masterFrame).toBe(5);
        expect(target.x).toBeCloseTo(5);
    });
});
