import { addToScene, createArcRotateCamera, createDirectionalLight, createHemisphericLight, createPbrMaterial, getContainerMeshes, loadGltf } from "babylon-lite";
import type { ArcRotateCamera, EngineContext, SceneContext } from "babylon-lite";

export const KITCHEN_CAMERA = { alpha: 1.8, beta: 1.4, radius: 1.5, x: 0, y: 1.3, z: 0 } as const;
export const KITCHEN_SOURCE = {
    repository: "DiligentGraphics/USDAssets",
    commit: "c823af8961047f4642c985c37338b18a35b6b017",
    blob: "f0cddb55f5f7b2c246f32978ddde4d0cf797160a",
} as const;

/** Shared metre-scaled geometry, original vertex colors, lighting and camera. */
export async function createKitchenScene(engine: EngineContext, scene: SceneContext, url: string): Promise<ArcRotateCamera> {
    const asset = await loadGltf(engine, url);
    const material = createPbrMaterial();
    material.baseColorFactor = [1, 1, 1, 1];
    material.metallicFactor = 0;
    material.roughnessFactor = 0.9;
    for (const mesh of getContainerMeshes(asset)) {
        mesh.material = material;
    }
    addToScene(scene, asset);
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.5));
    addToScene(scene, createDirectionalLight([0.3, -1, 0.45], 1.1));
    const preset = KITCHEN_CAMERA;
    const camera = createArcRotateCamera(preset.alpha, preset.beta, preset.radius, { x: preset.x, y: preset.y, z: preset.z });
    camera.nearPlane = 0.05;
    camera.farPlane = 20;
    scene.camera = camera;
    return camera;
}

/** Deterministic interior camera motion; used for the native shared-input recording. */
export function moveKitchenCamera(camera: ArcRotateCamera, offset: number): void {
    camera.alpha = KITCHEN_CAMERA.alpha - offset;
    camera.beta = KITCHEN_CAMERA.beta + offset * 0.1;
}
