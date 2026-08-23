// Scene 167 — PBR Lightmap
// Exercises the PBR material's lightmap channel:
//   • the glTF level (levelTest.glb, which ships a TEXCOORD_1 set) keeps its glTF PBR
//     materials and gets the baked lightmap on UV2 as a SHADOWMAP (multiply), level 3.2,
//     sRGB-decoded, with the BJS `uAng = π` V-flip;
//   • two procedural PBR boxes get the same texture ADDITIVELY on UV1 at level 0.8.
// Together these cover every branch of the lightmap fragment (uv1/uv2, add/multiply,
// gamma decode, V-flip).

import {
    addToScene,
    createBox,
    createEngine,
    createFreeCamera,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    enablePbrLightmap,
    loadGltf,
    loadTexture2D,
    registerScene,
    setPbrLightmap,
    startEngine,
    type PbrMaterialProps,
} from "babylon-lite";

const LEVEL_URL = "https://cdn.jsdelivr.net/gh/CedricGuillemet/dump@master/CharController/levelTest.glb";
const LIGHTMAP_URL = "https://cdn.jsdelivr.net/gh/CedricGuillemet/dump@master/CharController/lightmap.jpg";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const camera = createFreeCamera({ x: 3, y: 5, z: -16 }, { x: 3, y: 0, z: -6 });
    scene.camera = camera;

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    // Lightmaps are an opt-in PBR extension (zero bytes for scenes that never call this).
    await enablePbrLightmap();

    // Raw (non-sRGB) upload, so the shader does the sRGB→linear decode — this is what
    // `gamma` selects, and it matches BJS `Texture.gammaSpace = true` (the default).
    const lightmap = await loadTexture2D(engine, LIGHTMAP_URL);
    lightmap.uAng = Math.PI;

    const container = await loadGltf(engine, LEVEL_URL);
    addToScene(scene, container);
    // Only the `level` meshes carry TEXCOORD_1 (the `Cube*` props do not), so the UV2 lightmap
    // goes on their materials alone — same split as scene104.
    for (const mesh of scene.meshes) {
        if (mesh.name !== "level") {
            continue;
        }
        const mat = mesh.material as PbrMaterialProps | undefined;
        if (mat) {
            setPbrLightmap(mat, lightmap, { coordIndex: 1, level: 3.2, useAsShadowmap: true, gamma: true });
        }
    }

    // Additive lightmap on UV1 (procedural boxes carry no TEXCOORD_1).
    const boxMaterial = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.32, 0.32, 0.34, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.55, 0.0, 1),
    });
    setPbrLightmap(boxMaterial, lightmap, { coordIndex: 0, level: 0.8, gamma: true });
    for (const x of [0.5, 5.5]) {
        const box = createBox(engine, 2);
        box.position.set(x, 1, -12);
        box.material = boxMaterial;
        addToScene(scene, box);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
