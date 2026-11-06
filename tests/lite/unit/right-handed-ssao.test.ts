import { describe, expect, it, vi } from "vitest";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target.js";
import { createSsaoTask } from "../../../packages/babylon-lite/src/post-process/ssao.js";

vi.mock("../../../packages/babylon-lite/src/engine/coordinate-system", () => import("../../../packages/babylon-lite/src/engine/coordinate-system-rh"));

describe("right-handed SSAO boundary", () => {
    it("rejects the unsupported normal contract before allocating GPU resources", () => {
        const createTexture = vi.fn();
        const engine = { _device: { createTexture } } as unknown as EngineContext;
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        const depthTexture = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 128, height: 96 } });
        expect(() => createSsaoTask({ depthTexture, camera }, engine)).toThrow("left-handed builds");
        expect(createTexture).not.toHaveBeenCalled();
    });
});
