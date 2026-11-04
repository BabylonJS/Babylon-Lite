/**
 * Null-engine headless simulation test — runs in the `no-webgpu` project, i.e. with NO WebGPU
 * globals present (see vitest.config.ts). This proves the null engine drives a scene's per-frame
 * simulation (physics/animation via `onBeforeRender`) on a plain Node server with zero GPU device,
 * zero canvas, and zero rendering.
 *
 * The real end-to-end (real Havok WASM dropping a box onto a ground) is validated separately as a
 * Deno/Node runtime artifact; here we use a deterministic gravity integrator registered through the
 * public `onBeforeRender` API so the test has no native dependency.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createNullEngine, stepScene, runHeadlessSteps } from "../../../packages/babylon-lite/src/engine/null-engine.js";
import { createSceneContext, onBeforeRender } from "../../../packages/babylon-lite/src/scene/scene-core.js";

describe("null engine (headless, no WebGPU)", () => {
    beforeAll(() => {
        // Match the sibling import-safety test: ensure no WebGPU flag namespaces are present so
        // this genuinely exercises a WebGPU-free (Node/SSR) environment.
        const g = globalThis as Record<string, unknown>;
        delete g.GPUShaderStage;
        delete g.GPUTextureUsage;
        delete g.GPUBufferUsage;
        delete g.GPUColorWrite;
    });

    it("creates a device-less engine that is its own primary surface", () => {
        const engine = createNullEngine();
        expect(engine).toBeDefined();
        expect(engine.engine).toBe(engine); // engine IS its primary surface
        expect(engine.surfaces[0]).toBe(engine);
        expect(engine.useFloatingOrigin).toBe(false);
        // No GPU device is attached on a null engine.
        expect((engine as { _device?: unknown })._device).toBeUndefined();
    });

    it("creates a headless scene with no render task", () => {
        const engine = createNullEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        expect(scene).toBeDefined();
        expect(scene.meshes).toHaveLength(0);
        expect(scene.surface).toBe(engine);
    });

    it("stepScene fires onBeforeRender with the given delta and integrates a body under gravity", () => {
        const engine = createNullEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });

        const deltas: number[] = [];
        const body = { y: 10, vy: 0 };
        const gravityY = -9.81;
        onBeforeRender(scene, (dtMs: number) => {
            deltas.push(dtMs);
            const dt = dtMs / 1000;
            body.vy += gravityY * dt;
            body.y += body.vy * dt;
        });

        const stepMs = 1000 / 60;
        for (let i = 0; i < 60; i++) {
            stepScene(engine, scene, stepMs);
        }

        // Callback ran once per step with the exact delta we passed.
        expect(deltas).toHaveLength(60);
        expect(deltas.every((d) => d === stepMs)).toBe(true);

        // Semi-implicit Euler over 1s from rest ≈ analytic 0.5*g*t² within integrator error.
        const analytic = 10 + 0.5 * gravityY * 1 * 1; // ≈ 5.095
        expect(body.y).toBeGreaterThan(analytic - 0.5);
        expect(body.y).toBeLessThan(analytic + 0.5);
        expect(body.y).toBeLessThan(10); // it fell
    });

    it("runHeadlessSteps advances the same number of steps as manual stepping", () => {
        const engine = createNullEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });

        let ticks = 0;
        onBeforeRender(scene, () => {
            ticks++;
        });

        runHeadlessSteps(engine, scene, 120, 1000 / 60);
        expect(ticks).toBe(120);
    });
});
