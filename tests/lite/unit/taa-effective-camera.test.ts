import { describe, expect, it, vi } from "vitest";

vi.mock("../../../packages/babylon-lite/src/frame-graph/post-process-task", () => ({
    createPostProcessTask: () => ({ record() {}, execute: () => 0, updateUniforms() {}, dispose() {} }),
}));

import { _cameraChangeKey, type Camera } from "../../../packages/babylon-lite/src/camera/camera";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import { createTaaPostProcessTask } from "../../../packages/babylon-lite/src/post-process/taa";

function equalVersionCameras(): [Camera, Camera, Camera] {
    const a = createFreeCamera({ x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const b = createFreeCamera({ x: -250, y: 40, z: 75 }, { x: 0, y: 0, z: 0 });
    const c = createFreeCamera({ x: 0, y: 300, z: -20 }, { x: 0, y: 0, z: 0 });
    expect(_cameraChangeKey(b)).toBe(_cameraChangeKey(a));
    expect(_cameraChangeKey(c)).toBe(_cameraChangeKey(a));
    return [a, b, c];
}

/** A TAA task over a source render task whose `cam` override differs from the scene camera. The
 *  sub-passes are stubbed and the source texture is unsized, so `execute` only runs the camera
 *  tracking and the blend-factor choice. */
function taaOverOverride(override: Camera, sceneCamera: Camera) {
    const scene = { camera: sceneCamera };
    const source = { scene, _config: { cam: override } } as unknown as RenderTask;
    const engine = { scRT: createRenderTarget({ lbl: "sc", format: "rgba8unorm", samples: 1, size: { width: 4, height: 4 } }) } as unknown as EngineContext;
    const sourceTexture = createRenderTarget({ lbl: "src", format: "rgba8unorm", samples: 1, size: { width: 4, height: 4 } });
    const taa = createTaaPostProcessTask({ sourceTexture, sourceRenderTask: source }, engine);
    const factor = () => (taa as unknown as { _factor: number })._factor;
    const frame = () => {
        taa.execute!();
        return factor();
    };
    return { scene, source, frame };
}

describe("TAA tracks the source task's effective camera", () => {
    it("keeps history when only the scene camera behind a fixed cam override is replaced", () => {
        const [override, a, b] = equalVersionCameras();
        const { scene, frame } = taaOverOverride(override, a);

        expect(frame()).toBe(1);
        expect(frame()).toBe(0.05);

        scene.camera = b;
        expect(frame()).toBe(0.05);
    });

    it("resets history when the cam override itself is replaced", () => {
        const [override, a, replacement] = equalVersionCameras();
        const { source, frame } = taaOverOverride(override, a);

        expect(frame()).toBe(1);
        expect(frame()).toBe(0.05);

        (source._config as { cam?: Camera }).cam = replacement;
        expect(frame()).toBe(1);
        expect(frame()).toBe(0.05);
    });
});
