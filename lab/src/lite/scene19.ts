// Scene 19: PBR Clearcoat — sphere with glossy transparent top layer
//
// Uses DDS environment for IBL. Sphere has metallic=0, roughness=1,
// clearcoat enabled with IOR=2.0. No direct light — only IBL from DDS env +
// default hemispheric light from createDefaultCamera equivalent.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createHemisphericLight, createSphere, createPbrMaterial, createSolidTexture2D, attachControl, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";
import { loadDdsEnvironment } from "babylon-lite/loader-env/load-dds-env";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    // Arc-rotate camera matching BJS createDefaultCamera(true,true,true)
    // BJS: alpha=-PI/2, beta=PI/2, radius=worldSize.length()=sqrt(12) for unit sphere
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, Math.sqrt(12), { x: 0, y: 0, z: 0 });
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    // Hemispheric light (BJS createDefaultCamera creates a hemi light with intensity 0.7)
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));

    // DDS environment for IBL
    await loadDdsEnvironment(scene, "https://playground.babylonjs.com/textures/environment.dds", {
        brdfUrl: "/brdf-lut.png",
    });

    // Sphere (BJS: CreateSphere("sphere", 16, 2) = 16 segments, diameter 2)
    const sphere = createSphere(engine, { segments: 16, diameter: 2 });

    // 1×1 white base color (no texture, just solid white)
    const baseColorTex = createSolidTexture2D(engine, 1.0, 1.0, 1.0);
    // ORM: occlusion=1, roughness=1, metallic=0
    const ormTex = createSolidTexture2D(engine, 1.0, 1.0, 0.0);

    sphere.material = createPbrMaterial({
        baseColorTexture: baseColorTex,
        ormTexture: ormTex,
        clearCoat: {
            isEnabled: true,
            intensity: 1.0,
            roughness: 0.0,
            indexOfRefraction: 2.0,
        },
    });

    addToScene(scene, sphere);
    await registerScene(engine, scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

void main();
