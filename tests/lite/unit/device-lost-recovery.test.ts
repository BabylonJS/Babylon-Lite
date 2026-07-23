import { describe, expect, it, vi } from "vitest";

import {
    _assertDeviceLostRecoveryContextsSupported,
    _enableDeviceLostRecovery,
    markNextDeviceLossForRecovery,
} from "../../../packages/babylon-lite/src/engine/device-lost-recovery.js";
import { enableDeviceLostSceneRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-scene-recovery.js";
import { enableDeviceLostSpriteRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-sprite-recovery.js";
import { enableDeviceLostTextRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-text-recovery.js";
import type { EngineContext, RenderingContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";

function context(kind: string): RenderingContext {
    return {
        _kind: kind,
        _drawCallsPre: 0,
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
        _update(): void {
            return;
        },
        _record(): number {
            return 0;
        },
    };
}

function engineWith(...contexts: RenderingContext[]): EngineContext {
    return {
        surfaces: [{ _renderingContexts: contexts } as unknown as SurfaceContext],
    } as unknown as EngineContext;
}

describe("device-lost recovery context dispatch", () => {
    it("keeps a context recovery strategy enabled until every registration is disabled", () => {
        const enable = vi.fn();
        const disable = vi.fn();
        const engine = {
            _device: {
                features: new Set<GPUFeatureName>(),
                lost: new Promise<GPUDeviceLostInfo>(() => undefined),
            },
        } as unknown as EngineContext;
        const registration = {
            _kind: "scene",
            _recover: vi.fn(),
            _enable: enable,
            _disable: disable,
        };

        const first = _enableDeviceLostRecovery(engine, registration);
        const second = _enableDeviceLostRecovery(engine, registration);
        expect(enable).toHaveBeenCalledTimes(1);
        expect(markNextDeviceLossForRecovery(engine)).toBe(true);

        first.disable();
        expect(disable).not.toHaveBeenCalled();
        expect(markNextDeviceLossForRecovery(engine)).toBe(true);

        second.disable();
        expect(disable).toHaveBeenCalledTimes(1);
        expect(markNextDeviceLossForRecovery(engine)).toBe(false);
    });

    it("accepts only rendering-context kinds with enabled recovery handlers", () => {
        const engine = engineWith(context("scene"), context("scene"));

        expect(() => _assertDeviceLostRecoveryContextsSupported(engine, new Map([["scene", true]]))).not.toThrow();
    });

    it("rejects an unsupported rendering-context kind instead of treating it as a scene", () => {
        const engine = engineWith(context("scene"), context("sprite-renderer"));

        expect(() => _assertDeviceLostRecoveryContextsSupported(engine, new Map([["scene", true]]))).toThrow(
            'Device-lost recovery is not enabled for rendering context kind "sprite-renderer"'
        );
    });

    it("accepts mixed Scene, SpriteRenderer, and TextRenderer contexts only when every exact kind is enabled", () => {
        const engine = engineWith(context("scene"), context("sprite-renderer"), context("text-renderer"));
        const handlers = new Map([
            ["scene", true],
            ["sprite-renderer", true],
            ["text-renderer", true],
        ]);

        expect(() => _assertDeviceLostRecoveryContextsSupported(engine, handlers)).not.toThrow();
    });

    it("keeps shared texture capture alive across repeated and cross-kind handles", () => {
        const engine = {
            _device: {
                features: new Set<GPUFeatureName>(),
                lost: new Promise<GPUDeviceLostInfo>(() => undefined),
            },
        } as unknown as EngineContext;

        const scene = enableDeviceLostSceneRecovery(engine);
        const sprite1 = enableDeviceLostSpriteRecovery(engine);
        const sprite2 = enableDeviceLostSpriteRecovery(engine);
        const text = enableDeviceLostTextRecovery(engine);
        expect(engine._dlr).toBeDefined();
        expect(engine._deviceLostRecovery?._registrations.map((registration) => registration._kind)).toEqual(["scene", "sprite-renderer", "sprite-renderer", "text-renderer"]);

        sprite1.disable();
        scene.disable();
        expect(engine._dlr).toBeDefined();

        sprite2.disable();
        expect(engine._dlr).toBeUndefined();
        text.disable();
        text.disable();
        expect(markNextDeviceLossForRecovery(engine)).toBe(false);
    });

    it("retains mesh geometry only while Scene recovery is enabled", () => {
        const engine = {
            _device: {
                features: new Set<GPUFeatureName>(),
                lost: new Promise<GPUDeviceLostInfo>(() => undefined),
            },
        } as unknown as EngineContext;
        const mesh = {} as Mesh;
        const indices = new Uint16Array([0, 1, 2]);
        const sprite = enableDeviceLostSpriteRecovery(engine);

        engine._dlr!.m(mesh, null, null, null, indices, "uint16");
        expect(mesh._cpuGpuIndices).toBeUndefined();

        const scene = enableDeviceLostSceneRecovery(engine);
        engine._dlr!.m(mesh, null, null, null, indices, "uint16");
        expect(mesh._cpuGpuIndices).toBe(indices);

        scene.disable();
        const replacement = new Uint16Array([2, 1, 0]);
        engine._dlr!.m(mesh, null, null, null, replacement, "uint16");
        expect(mesh._cpuGpuIndices).toBe(indices);
        sprite.disable();
    });
});
