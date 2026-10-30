import { describe, expect, it, vi } from "vitest";

import { NullEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";
import { Animation } from "../src/animations/animation";
import type { Animatable } from "../src/animations/animation";
import { LiteCompatError } from "../src/error";

/**
 * Babylon.js reports the end of an animatable through the `onAnimationEnd` argument of `beginAnimation` /
 * `beginDirectAnimation`, `Animatable.onAnimationEnd`, `onAnimationEndObservable` and `waitAsync()`: when it runs to
 * its end, and when it is stopped. `beginAnimation` stops the target's running animatables first (`stopCurrent`), and
 * `scene.stopAnimation(target)` stops them. These run on a headless `NullEngine` scene, ticked by hand.
 */
function slide(interpolation?: number): Animation {
    const animation = new Animation("slide", "position.x", 10);
    // A STEP start key mixed with linear ones keeps the track on the compat CPU evaluator.
    animation.setKeys([
        { frame: 0, value: 0, ...(interpolation === undefined ? {} : { interpolation }) },
        { frame: 5, value: 5 },
        { frame: 10, value: 10 },
    ]);
    return animation;
}

describe.each([
    ["delegated to Lite", undefined],
    ["on the compat fallback", 1],
] as const)("an animatable %s", (_path, interpolation) => {
    it("reports its end once, through the callback, the observable and waitAsync", async () => {
        const scene = new Scene(new NullEngine());
        const target = { position: { x: 0 } };
        const onEnd = vi.fn();
        const animatable = scene.beginDirectAnimation(target, [slide(interpolation)], 0, 10, false, 1, onEnd);
        expect(animatable._lite === undefined).toBe(interpolation !== undefined);
        const observed = vi.fn();
        animatable.onAnimationEndObservable.add(observed);
        const done = animatable.waitAsync();

        scene._tick(500);
        expect(onEnd).not.toHaveBeenCalled();
        expect(observed).not.toHaveBeenCalled();

        scene._tick(600);
        scene._tick(600);

        expect(target.position.x).toBe(10);
        expect(onEnd).toHaveBeenCalledTimes(1);
        expect(observed).toHaveBeenCalledTimes(1);
        expect(observed).toHaveBeenCalledWith(animatable);
        expect(onEnd.mock.invocationCallOrder[0]).toBeLessThan(observed.mock.invocationCallOrder[0]!);
        await expect(done).resolves.toBe(animatable);
    });

    it("reports the end of a looping animation only when it is stopped, once", () => {
        const scene = new Scene(new NullEngine());
        const onEnd = vi.fn();
        const animatable = scene.beginDirectAnimation({ position: { x: 0 } }, [slide(interpolation)], 0, 10, true, 1, onEnd);

        for (let i = 0; i < 5; i++) {
            scene._tick(600);
        }
        expect(onEnd).not.toHaveBeenCalled();

        animatable.stop();
        animatable.stop();
        scene._tick(600);
        expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("clears its end callback and observers once it completed, unless disposeOnEnd is false", () => {
        const scene = new Scene(new NullEngine());
        const disposed = scene.beginDirectAnimation({ position: { x: 0 } }, [slide(interpolation)], 0, 10, false, 1, vi.fn());
        disposed.onAnimationEndObservable.add(vi.fn());
        const kept = scene.beginDirectAnimation({ position: { x: 0 } }, [slide(interpolation)], 0, 10, false, 1, vi.fn());
        kept.disposeOnEnd = false;
        kept.onAnimationEndObservable.add(vi.fn());

        scene._tick(1100);

        expect(disposed.onAnimationEnd).toBeNull();
        expect(disposed.onAnimationEndObservable.hasObservers()).toBe(false);
        expect(kept.onAnimationEnd).not.toBeNull();
        expect(kept.onAnimationEndObservable.hasObservers()).toBe(true);
    });

    it("raises its end on stop() while paused, and not after it completed or with skipOnAnimationEnd", () => {
        const scene = new Scene(new NullEngine());
        const onPausedEnd = vi.fn();
        const onSkippedEnd = vi.fn();
        const onCompletedEnd = vi.fn();
        const paused = scene.beginDirectAnimation({ position: { x: 0 } }, [slide(interpolation)], 0, 10, true, 1, onPausedEnd);
        const skipped = scene.beginDirectAnimation({ position: { x: 0 } }, [slide(interpolation)], 0, 10, true, 1, onSkippedEnd);
        const completed = scene.beginDirectAnimation({ position: { x: 0 } }, [slide(interpolation)], 0, 10, false, 1, onCompletedEnd);
        // Kept, so a second raise would be seen.
        completed.disposeOnEnd = false;
        scene._tick(1100);
        expect(onCompletedEnd).toHaveBeenCalledTimes(1);

        paused.pause();
        paused.stop();
        skipped.stop(undefined, undefined, false, true);
        completed.stop();

        expect(onPausedEnd).toHaveBeenCalledTimes(1);
        expect(onSkippedEnd).not.toHaveBeenCalled();
        expect(onCompletedEnd).toHaveBeenCalledTimes(1);
        expect(skipped.animationStarted).toBe(false);
    });

    it("first advances an animation chained from its end on the next frame", () => {
        const scene = new Scene(new NullEngine());
        const target = { position: { x: 0 } };
        let started = 0;
        // Each animation lasts 0.1 s; before the fix the whole chain ran within one tick (capped here so it cannot hang).
        const next = (): void => {
            if (++started < 50) {
                scene.beginDirectAnimation(target, [slide(interpolation)], 0, 1, false, 1, next);
            }
        };
        scene.beginDirectAnimation(target, [slide(interpolation)], 0, 1, false, 1, next);

        scene._tick(2000);

        expect(started).toBe(1);
        expect(target.position.x).toBe(0);
        scene._tick(2000);
        expect(started).toBe(2);
    });

    it("rejects stopping part of its tracks instead of stopping all of them", () => {
        const scene = new Scene(new NullEngine());
        const animatable = scene.beginDirectAnimation({ position: { x: 0 } }, [slide(interpolation)], 0, 10, true);

        expect(() => animatable.stop("slide")).toThrow(LiteCompatError);
        expect(() => animatable.stop(undefined, () => true)).toThrow(LiteCompatError);
        expect(animatable.animationStarted).toBe(true);
    });
});

describe("scene.beginAnimation and scene.stopAnimation", () => {
    it("stops the target's running animatables before starting, unless stopCurrent is false", () => {
        const scene = new Scene(new NullEngine());
        const target = { position: { x: 0 }, animations: [slide()] };
        const other = { position: { x: 0 }, animations: [slide()] };
        const firstEnd = vi.fn();
        const first = scene.beginAnimation(target, 0, 10, true, 1, firstEnd);
        const otherAnimatable = scene.beginAnimation(other, 0, 10, true);

        const kept = scene.beginAnimation(target, 0, 10, true, 1, undefined, undefined, false);
        expect(first.animationStarted).toBe(true);
        expect(firstEnd).not.toHaveBeenCalled();

        const second = scene.beginAnimation(target, 0, 10, true);

        expect(first.animationStarted).toBe(false);
        expect(kept.animationStarted).toBe(false);
        expect(firstEnd).toHaveBeenCalledTimes(1);
        expect(second.animationStarted).toBe(true);
        expect(otherAnimatable.animationStarted).toBe(true);
    });

    it("stops every animatable of the target, and keeps one its end callback starts", () => {
        const scene = new Scene(new NullEngine());
        const target = { position: { x: 0 }, animations: [slide()] };
        let restarted: ReturnType<Scene["beginAnimation"]> | undefined;
        const first = scene.beginDirectAnimation(target, target.animations, 0, 10, true, 1, () => {
            restarted = scene.beginAnimation(target, 10, 0, false, 1, undefined, undefined, false);
        });

        scene.stopAnimation(target);

        expect(first.animationStarted).toBe(false);
        expect(restarted?.animationStarted).toBe(true);
    });

    it("rejects what it cannot honour instead of ignoring it", () => {
        const scene = new Scene(new NullEngine());
        const target = { position: { x: 0 }, animations: [slide()] };
        const animatable = scene.beginAnimation(target, 0, 10, true);

        expect(() => scene.beginAnimation(target, 0, 10, true, 1, undefined, animatable)).toThrow(LiteCompatError);
        expect(() => scene.stopAnimation(target, "slide")).toThrow(LiteCompatError);
        expect(() => scene.stopAnimation(target, undefined, () => true)).toThrow(LiteCompatError);
        expect(animatable.animationStarted).toBe(true);
    });
});

const CYCLE = Animation.ANIMATIONLOOPMODE_CYCLE;
// A non-looping CONSTANT track keeps its interpolation but runs on the compat fallback.
const CONSTANT = Animation.ANIMATIONLOOPMODE_CONSTANT;

describe.each([
    ["delegated to Lite", [CYCLE]],
    ["on the compat fallback", [CONSTANT]],
    ["split between Lite and the compat fallback", [CYCLE, CONSTANT]],
] as const)("an animatable %s that another animatable's end callback changes", (_path, modes) => {
    function ramp(name: string, property: string, frames: number, mode: number): Animation {
        const animation = new Animation(name, property, 10, Animation.ANIMATIONTYPE_FLOAT, mode);
        animation.setKeys([
            { frame: 0, value: 0 },
            { frame: frames, value: frames },
        ]);
        return animation;
    }

    /** The second animatable's target and tracks: x on the first mode, y on the second when there is one. */
    function second(frames: number) {
        const target = { position: { x: 0, y: 0 } };
        const animations = modes.map((mode, i) => ramp(`second${i}`, i === 0 ? "position.x" : "position.y", frames, mode));
        const values = (): number[] => (modes.length === 1 ? [target.position.x] : [target.position.x, target.position.y]);
        return { target, animations, values };
    }

    function start(scene: Scene, frames: number, onEnd: () => void) {
        const tracks = second(frames);
        const animatable = scene.beginDirectAnimation(tracks.target, tracks.animations, 0, frames, false, 1, onEnd);
        const used: readonly number[] = modes;
        expect(animatable._lite !== undefined).toBe(used.includes(CYCLE));
        expect(animatable._nativeFallbackReason !== undefined).toBe(used.includes(CONSTANT));
        return { ...tracks, animatable };
    }

    const first = (scene: Scene, onEnd: () => void): Animatable =>
        scene.beginDirectAnimation({ position: { x: 0 } }, [ramp("first", "position.x", 10, CYCLE)], 0, 10, false, 1, onEnd);

    it("stops where this frame advanced it, unlike Babylon.js, when the callback stops it", () => {
        const scene = new Scene(new NullEngine());
        const onSecondEnd = vi.fn();
        const later: { b?: ReturnType<typeof start> } = {};
        // Done after one second: its end is reported while the second, two seconds long, is halfway through.
        first(scene, () => scene.stopAnimation(later.b!.target));
        const b = (later.b = start(scene, 20, onSecondEnd));

        scene._tick(1100);

        // Every animatable advanced before any end was reported. Babylon.js, which steps them one at a time, would leave 0.
        for (const value of b.values()) {
            expect(value).toBeCloseTo(11, 5);
        }
        expect(b.animatable.animationStarted).toBe(false);
        expect(onSecondEnd).toHaveBeenCalledTimes(1);
        scene._tick(1100);
        for (const value of b.values()) {
            expect(value).toBeCloseTo(11, 5);
        }
    });

    it("first advances on the next frame when the callback resumes it", () => {
        const scene = new Scene(new NullEngine());
        const onSecondEnd = vi.fn();
        const later: { b?: ReturnType<typeof start> } = {};
        first(scene, () => later.b!.animatable.restart());
        const b = (later.b = start(scene, 10, onSecondEnd));
        b.animatable.pause();

        scene._tick(1100);

        expect(b.values().every((value) => value === 0)).toBe(true);
        expect(b.animatable.animationStarted).toBe(true);
        expect(onSecondEnd).not.toHaveBeenCalled();
        scene._tick(1100);
        expect(b.values().every((value) => value === 10)).toBe(true);
        expect(onSecondEnd).toHaveBeenCalledTimes(1);
    });

    describe("ending in the same frame", () => {
        it.each([
            ["before", false],
            ["after", true],
        ] as const)("reports its end once when created %s the one whose callback stops it", (_order, secondFirst) => {
            const scene = new Scene(new NullEngine());
            const onSecondEnd = vi.fn();
            const later: { b?: ReturnType<typeof start> } = {};
            if (secondFirst) {
                later.b = start(scene, 10, onSecondEnd);
            }
            first(scene, () => later.b!.animatable.stop());
            const b = (later.b ??= start(scene, 10, onSecondEnd));

            scene._tick(1100);
            scene._tick(1100);

            expect(onSecondEnd).toHaveBeenCalledTimes(1);
            expect(b.animatable.animationStarted).toBe(false);
        });

        it("reports no end when the callback pauses it, and reports it once resumed", () => {
            const scene = new Scene(new NullEngine());
            const onSecondEnd = vi.fn();
            const later: { b?: ReturnType<typeof start> } = {};
            first(scene, () => later.b!.animatable.pause());
            const b = (later.b = start(scene, 10, onSecondEnd));

            scene._tick(1100);
            expect(onSecondEnd).not.toHaveBeenCalled();
            expect(b.animatable.animationStarted).toBe(false);

            b.animatable.restart();
            scene._tick(1100);
            expect(onSecondEnd).toHaveBeenCalledTimes(1);
        });

        it("reports no end when the callback seeks it, and plays on from there", () => {
            const scene = new Scene(new NullEngine());
            const onSecondEnd = vi.fn();
            const later: { b?: ReturnType<typeof start> } = {};
            first(scene, () => later.b!.animatable.goToFrame(0));
            const b = (later.b = start(scene, 10, onSecondEnd));

            scene._tick(1100);
            expect(onSecondEnd).not.toHaveBeenCalled();
            expect(b.values().every((value) => value === 0)).toBe(true);

            scene._tick(500);
            expect(b.values().every((value) => Math.abs(value - 5) < 1e-5)).toBe(true);
            scene._tick(600);
            expect(onSecondEnd).toHaveBeenCalledTimes(1);
        });

        it("reports its end on the next frame when the callback restarts it", () => {
            const scene = new Scene(new NullEngine());
            const onSecondEnd = vi.fn();
            const later: { b?: ReturnType<typeof start> } = {};
            first(scene, () => later.b!.animatable.restart());
            later.b = start(scene, 10, onSecondEnd);

            scene._tick(1100);
            expect(onSecondEnd).not.toHaveBeenCalled();
            scene._tick(100);
            expect(onSecondEnd).toHaveBeenCalledTimes(1);
        });
    });
});

describe("scene._tick when a scene is disposed during the advance", () => {
    it("does not throw when a property setter of a fallback track disposes the scene", () => {
        const scene = new Scene(new NullEngine());
        let armed = false;
        let disposed = 0;
        // The fallback evaluator writes through this setter inside the first pass; it disposes the scene once armed.
        const target = {
            position: {
                _x: 0,
                get x(): number {
                    return this._x;
                },
                set x(value: number) {
                    this._x = value;
                    if (armed && !disposed++) {
                        scene.dispose();
                    }
                },
            },
        };
        const constant = (name: string): Animation => {
            const animation = new Animation(name, "position.x", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
            animation.setKeys([
                { frame: 0, value: 0 },
                { frame: 10, value: 10 },
            ]);
            return animation;
        };
        const first = scene.beginDirectAnimation(target, [constant("first")], 0, 10, false);
        const second = scene.beginDirectAnimation({ position: { x: 0 } }, [constant("second")], 0, 10, false);
        expect(first._lite).toBeUndefined();
        expect(second._lite).toBeUndefined();
        armed = true;

        expect(() => scene._tick(500)).not.toThrow();
        expect(disposed).toBe(1);
        expect(scene.animatables).toHaveLength(0);
    });
});
