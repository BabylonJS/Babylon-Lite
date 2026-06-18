import { describe, expect, it } from "vitest";

import { NullEngine, WebGPUEngine, AbstractEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";
import { Animation } from "../src/animations/animation";

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

    it("constructs a Scene with no GPU context", () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        expect(scene.getEngine()).toBe(engine);
        // The headless scene tracks no Lite render context, but its entity
        // registries and animation surface still work.
        expect(scene.cameras).toEqual([]);
        expect(scene.dispose()).toBeUndefined();
    });

    it("evaluates a direct animation onto a plain target each tick", () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const target = { position: { x: -2 } };

        const slide = new Animation("slide", "position.x", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
        slide.setKeys([
            { frame: 0, value: -2 },
            { frame: 10, value: 2 },
            { frame: 20, value: -2 },
        ]);
        const animatable = scene.beginDirectAnimation(target, [slide], 0, 20, true);

        // Seeking applies the evaluated value synchronously (no render loop needed).
        animatable.goToFrame(5);
        expect(target.position.x).toBeCloseTo(0, 6);
        animatable.goToFrame(10);
        expect(target.position.x).toBeCloseTo(2, 6);

        // A manual tick advances the running animation on the CPU.
        animatable.restart();
        target.position.x = -2;
        scene._tick(500); // 0.5s @ 10fps = 5 frames → midway to +2
        expect(target.position.x).toBeCloseTo(0, 6);
    });
});
