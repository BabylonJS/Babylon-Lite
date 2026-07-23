import { describe, expect, it, vi } from "vitest";

import {
    _assertDeviceLostRecoveryContextsSupported,
    _enableDeviceLostRecovery,
    markNextDeviceLossForRecovery,
} from "../../../packages/babylon-lite/src/engine/device-lost-recovery.js";
import type { EngineContext, RenderingContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface.js";

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
});
