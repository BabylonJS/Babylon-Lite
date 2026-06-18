import { describe, expect, it } from "vitest";

import { Animation, AnimationGroup, AnimationKeyInterpolation } from "../src/animations/animation";

describe("Animation", () => {
    it("exposes Babylon.js data-type and loop-mode constants", () => {
        expect(Animation.ANIMATIONTYPE_FLOAT).toBe(0);
        expect(Animation.ANIMATIONTYPE_VECTOR3).toBe(1);
        expect(Animation.ANIMATIONLOOPMODE_CYCLE).toBe(1);
    });

    it("sorts keys and reports the highest frame", () => {
        const anim = new Animation("a", "position.x", 60);
        anim.setKeys([
            { frame: 30, value: 5 },
            { frame: 0, value: 0 },
        ]);
        expect(anim.getKeys()[0]!.frame).toBe(0);
        expect(anim.getHighestFrame()).toBe(30);
    });

    it("evaluates float keys with linear interpolation and clamping", () => {
        const anim = new Animation("a", "position.x", 60);
        anim.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: 10 },
        ]);
        expect(anim.evaluate(-5)).toBe(0);
        expect(anim.evaluate(5)).toBe(5);
        expect(anim.evaluate(10)).toBe(10);
        expect(anim.evaluate(20)).toBe(10);
    });

    it("evaluates vector (array) keys componentwise", () => {
        const anim = new Animation("a", "position", 60, Animation.ANIMATIONTYPE_VECTOR3);
        anim.setKeys([
            { frame: 0, value: [0, 0, 0] },
            { frame: 10, value: [10, 20, 30] },
        ]);
        expect(anim.evaluate(5)).toEqual([5, 10, 15]);
    });

    it("builds a one-shot animation via CreateAndStartAnimation", () => {
        const anim = Animation.CreateAndStartAnimation("spin", {}, "rotation.y", 60, 60, 0, Math.PI);
        expect(anim.getHighestFrame()).toBe(60);
        expect(anim.evaluate(60)).toBeCloseTo(Math.PI, 6);
    });

    it("holds the start-key value across a STEP-interpolated segment", () => {
        expect(AnimationKeyInterpolation.STEP).toBe(1);
        const anim = new Animation("a", "position.x", 10);
        anim.setKeys([
            { frame: 0, value: -1.5, interpolation: AnimationKeyInterpolation.STEP },
            { frame: 10, value: 1.5, interpolation: AnimationKeyInterpolation.STEP },
            { frame: 20, value: -1.5, interpolation: AnimationKeyInterpolation.STEP },
        ]);
        // Within a STEP segment the value is held at the start key (no lerp)…
        expect(anim.evaluate(5)).toBe(-1.5);
        expect(anim.evaluate(9.9)).toBe(-1.5);
        // …and only changes when the next key is reached.
        expect(anim.evaluate(10)).toBe(1.5);
        expect(anim.evaluate(15)).toBe(1.5);
    });
});

describe("AnimationGroup", () => {
    it("tracks targeted animations and playback state", () => {
        const group = new AnimationGroup("group");
        const anim = new Animation("a", "position.x", 60);
        anim.setKeys([
            { frame: 0, value: 0 },
            { frame: 40, value: 1 },
        ]);
        group.addTargetedAnimation(anim, {});
        expect(group.to).toBe(40);
        expect(group.isPlaying).toBe(false);
        group.play();
        expect(group.isPlaying).toBe(true);
        expect(group.state).toBe("playing");
        group.pause();
        expect(group.state).toBe("paused");
        group.stop();
        expect(group.state).toBe("stopped");
    });
});

describe("AnimationGroup structural weighted blending", () => {
    class TestHost {
        public readonly groups: AnimationGroup[] = [];
        public _registerStructuralGroup(group: AnimationGroup): void {
            if (!this.groups.includes(group)) {
                this.groups.push(group);
            }
        }
        public _recomputeStructuralBlends(): void {
            AnimationGroup._blendStructuralGroups(this.groups);
        }
    }

    function slide(name: string, peak: number): Animation {
        const anim = new Animation(name, "position.x", 10);
        anim.setKeys([
            { frame: 0, value: 0 },
            { frame: 10, value: peak },
            { frame: 20, value: 0 },
        ]);
        return anim;
    }

    it("blends two groups by weight into the same property (scene 155)", () => {
        const host = new TestHost();
        const box = { position: { x: 0 } };

        const positive = new AnimationGroup("weightedPositive", host);
        positive.addTargetedAnimation(slide("pos", 2), box);
        positive.weight = 0.25;
        positive.start(true, 1, 0, 20);

        const negative = new AnimationGroup("weightedNegative", host);
        negative.addTargetedAnimation(slide("neg", -2), box);
        negative.weight = 0.75;
        negative.start(true, 1, 0, 20);

        positive.goToFrame(10);
        negative.goToFrame(10);

        // 2 * 0.25 + (-2) * 0.75 = -1
        expect(box.position.x).toBeCloseTo(-1, 6);
    });

    it("cross-fades by re-weighting at a fractional frame (scene 156)", () => {
        const host = new TestHost();
        const box = { position: { x: 0 } };

        const positive = new AnimationGroup("crossFadePositive", host);
        positive.addTargetedAnimation(slide("pos", 2), box);
        positive.weight = 1;
        positive.start(true, 1, 0, 20);

        const negative = new AnimationGroup("crossFadeNegative", host);
        negative.addTargetedAnimation(slide("neg", -2), box);
        negative.weight = 0;
        negative.start(true, 1, 0, 20);

        // seekTime 1.25 → frame 12.5, fadeT 0.25 → weights 0.75 / 0.25
        positive.weight = 0.75;
        negative.weight = 0.25;
        positive.goToFrame(12.5);
        negative.goToFrame(12.5);

        // pos@12.5 = 1.5, neg@12.5 = -1.5 → 1.5 * 0.75 + (-1.5) * 0.25 = 0.75
        expect(box.position.x).toBeCloseTo(0.75, 6);
    });

    it("falls back to the rest pose when total weight is below 1", () => {
        const host = new TestHost();
        const box = { position: { x: 0 } };

        const positive = new AnimationGroup("partial", host);
        positive.addTargetedAnimation(slide("pos", 2), box);
        positive.weight = 0.5;
        positive.start(true, 1, 0, 20);
        positive.goToFrame(10);

        // total weight 0.5 < 1 → 0 * 0.5 (original) + 2 * 0.5 = 1
        expect(box.position.x).toBeCloseTo(1, 6);
    });
});
