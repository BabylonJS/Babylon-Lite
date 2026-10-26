// Scene 320: glTF export of Standard-material planes with a transformed diffuse texture — matches Babylon.js playground
// #20OAV9#15148 (visualization test "Export GLTF Extension KHR_texture_transform").
//
// Four planes (no transform; rotation; offset; scale) are exported, and the export is loaded back into the same scene
// 1.5 units below the originals.
// - Per-texture transforms: Lite's Texture2D has uAng/uScale/vScale/uOffset/vOffset, and the Standard material samples
//   them after enableMaterialUvTransform(). Babylon.js `wAng` is the in-plane rotation (Lite: `uAng`, with the opposite
//   sign, as glTF `rotation`); `uRotationCenter = vRotationCenter = 0` is Lite's fixed rotation about the UV origin.
// - The snippet exports with `shouldExportNode: node.name.startsWith("plane")`, which leaves out the light and the camera.
//   Lite's exporter has no filter (it writes the scene camera and warns about a hemispheric light), so the light and the
//   camera are added after the export.

import {
    addToScene,
    attachControl,
    cloneTexture2D,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createPlane,
    createSceneContext,
    createStandardMaterial,
    enableMaterialUvTransform,
    exportSceneAsGlb,
    getContainerMeshes,
    loadGltf,
    loadTexture2D,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const TEXTURE_URL = "https://i.imgur.com/JbvoYlB.png";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const texture = await loadTexture2D(engine, TEXTURE_URL);
    const textures = [texture, cloneTexture2D(texture, { uAng: -0.3 }), cloneTexture2D(texture, { uOffset: 0.1, vOffset: 0.4 }), cloneTexture2D(texture, { uScale: 2, vScale: 3 })];

    for (let i = 0; i < textures.length; i++) {
        const material = createStandardMaterial();
        material.name = "mat" + i;
        material.diffuseTexture = textures[i]!;
        if (i > 0) {
            enableMaterialUvTransform(material);
        }
        const plane = createPlane(engine, { size: 1 });
        plane.name = "plane" + i;
        plane.material = material;
        plane.position.x = 1.5 * i;
        addToScene(scene, plane);
    }

    const glb = await exportSceneAsGlb(scene);
    addToScene(scene, createHemisphericLight([-1, 1, 0]));
    const container = await loadGltf(engine, glb);
    addToScene(scene, container);
    for (const mesh of getContainerMeshes(container)) {
        if (mesh.name.startsWith("plane")) {
            mesh.position.y -= 1.5;
            mesh.name = "imported_" + mesh.name;
        }
    }

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, textures.length * 4, { x: (textures.length / 2) * 1.5, y: 0, z: 0 });
    camera.nearPlane = 1;
    camera.farPlane = 10000;
    scene.camera = camera;
    attachControl(camera as ArcRotateCamera, canvas, scene);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
