// Scene 281: opt-in per-texture UV transform on a hand-built StandardMaterial.

import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createPlane,
    createSceneContext,
    createStandardMaterial,
    createTexture2DFromPixels,
    enableMaterialUvTransform,
    registerScene,
    startEngine,
} from "babylon-lite";
import { buildTexturePixels, TEXTURE_SIZE, UV_OFFSET, UV_ROTATION, UV_SCALE } from "../shared/scene281-standard-uv-transform.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.035, g: 0.045, b: 0.07, a: 1 };
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 4, { x: 0, y: 0, z: 0 });

    const texture = createTexture2DFromPixels(engine, buildTexturePixels(), TEXTURE_SIZE, TEXTURE_SIZE, {
        addressModeU: "repeat",
        addressModeV: "repeat",
        minFilter: "nearest",
        magFilter: "nearest",
    });
    texture.uScale = UV_SCALE[0];
    texture.vScale = UV_SCALE[1];
    texture.uOffset = UV_OFFSET[0];
    texture.vOffset = UV_OFFSET[1];
    texture.uAng = UV_ROTATION;
    texture.invertY = true;

    const material = createStandardMaterial();
    material.disableLighting = true;
    material.diffuseColor = [1, 1, 1];
    material.emissiveColor = [1, 1, 1];
    material.diffuseTexture = texture;
    enableMaterialUvTransform(material);

    const plane = createPlane(engine, { width: 3, height: 3 });
    plane.material = material;
    addToScene(scene, plane);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
