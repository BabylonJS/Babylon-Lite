import { expect, it } from "vitest";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate.js";
import { createGpuPicker, pickAsync } from "../../../packages/babylon-lite/src/picking/gpu-picker.js";

function stub<T extends object>(value: Partial<T>): T {
    return value as T;
}

it("bounds unstable preparation attempts, rejects explicitly and leaves the public pick queue usable", async () => {
    let reads = 0;
    const scene = stub<SceneContext>({
        surface: stub<SceneContext["surface"]>({ engine: stub<EngineContext>({ _device: stub<GPUDevice>({}) }) }),
        camera: createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 }),
        meshes: [],
        _pickSources: [],
        get _renderableVersion() {
            return reads++;
        },
    });
    const picker = createGpuPicker(scene);
    await expect(pickAsync(picker, 0, 0)).rejects.toThrow("16 consecutive preparations");
    expect(reads).toBe(32);
    scene.camera = null;
    expect((await pickAsync(picker, 0, 0)).hit).toBe(false);
    await expect(picker._pending).resolves.toBeUndefined();
});
