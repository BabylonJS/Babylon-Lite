// Scene 66: full NME playground (AT7YY5#6). Sphere + box casters, ground
// receiver, all three share a 136-block local NME material with local texture
// assets extracted out of the JSON to keep JS bundles small.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createSphere,
    createSphereData,
    createBox,
    createGround,
    createDirectionalLight,
    createPcfDirectionalShadowGenerator,
    createMorphTargets,
    attachControl,
    onBeforeRender,
    registerScene,
    loadTexture2D,
    parseNodeMaterialFromSnippet,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";
import { SCENE66_MORPH_PERIOD_MS, getScene66Nme, sanitizeName, sphereScrambleDeltas } from "../shared/scene66-nme.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    scene.camera = createArcRotateCamera(1.14, 0.95, 10, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera, canvas, scene);

    const light = createDirectionalLight([1, -1, 1], 0.7);
    addToScene(scene, light);

    // Meshes first (casters' world AABBs are needed for the shadow frustum fit).
    const sphere = createSphere(engine, { segments: 16, diameter: 2 }) as Mesh & { morphTargets?: unknown };
    sphere.position.set(-1.2, 1, 0);

    const box = createBox(engine, 1);
    box.position.set(1.2, 1, 0);

    const ground = createGround(engine, { width: 6, height: 6, subdivisions: 2 });
    ground.receiveShadows = true;

    // Morph target: scrambled copy of the sphere vertices, deterministic seed.
    // Created before the shadow generator so the depth pass can use morph targets.
    const sphereData = createSphereData({ segments: 16, diameter: 2 });
    const deltas = sphereScrambleDeltas(sphereData.vertexCount);
    const freeze = new URLSearchParams(location.search).has("freeze");
    // Freeze at max scramble (sin²(π/2)=1) for deterministic capture.
    const morph = createMorphTargets(engine, [{ positions: deltas, normals: null }], sphereData.vertexCount, [freeze ? 1 : 0]);
    sphere.morphTargets = morph;

    // PCF directional shadow (sphere + box are casters). orthoMinZ/orthoMaxZ
    // match BJS's shadowMinZ=-10, shadowMaxZ=10 on the light.
    const sg = createPcfDirectionalShadowGenerator(engine, light, [sphere, box], {
        mapSize: 1024,
        orthoMinZ: -10,
        orthoMaxZ: 10,
    });
    light.shadowGenerator = sg;

    // Load local NME JSON + local texture assets.
    const { json, textures } = await getScene66Nme();
    const textureOverrides: Record<string, Awaited<ReturnType<typeof loadTexture2D>>> = {};
    for (const t of textures) {
        // BJS snippet textures serialize coordinatesMode=7 (EQUIRECTANGULAR_MODE)
        // by default, but for TextureBlocks that's really "use the UV input".
        // We just upload them all as 2D; ReflectionTextureBlock interprets the
        // sampling coordinates itself in its WGSL emission.
        const key = sanitizeName(t.name);
        // BJS serialises texture.gammaSpace=true for color maps (diffuse/emissive/
        // ambient/light/reflection) and — in this snippet — for every TextureBlock.
        // We forward it verbatim so sampling matches BJS's sRGB-decoded values;
        // the graph was authored assuming that interpretation.
        textureOverrides[key] = await loadTexture2D(engine, t.url, {
            invertY: t.invertY ?? true,
            srgb: false, // NME textures work in gamma space, not linear
        });
    }

    const material = await parseNodeMaterialFromSnippet(engine, "", {
        json,
        textures: textureOverrides,
        shadowGenerators: [sg],
    });

    (sphere as { material?: unknown }).material = material;
    (box as { material?: unknown }).material = material;
    (ground as { material?: unknown }).material = material;

    addToScene(scene, sphere);
    addToScene(scene, box);
    addToScene(scene, ground);

    if (!freeze) {
        const t0 = performance.now();
        const w = new Float32Array([0]);
        onBeforeRender(scene, () => {
            const t = (performance.now() - t0) / SCENE66_MORPH_PERIOD_MS;
            const s = Math.sin(t * Math.PI * 2);
            w[0] = s * s;
            engine.device.queue.writeBuffer(morph.weightsBuffer, 0, w);
        });
    }

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
