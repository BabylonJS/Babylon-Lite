import { describe, expect, it } from "vitest";

import { NullEngine, WebGPUEngine, AbstractEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";
import { Animation } from "../src/animations/animation";
import { Color3, Color4 } from "../src/math/color";
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
