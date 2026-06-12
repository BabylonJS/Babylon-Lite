// Scene 26: PBR Subsurface / Translucency
// Based on playground #5H0H89#5 (Georgia Tech Dragon)
// Dragon with translucent teal PBR material, thickness map, point light, DDS environment

import { addToScene, startEngine, onBeforeRender, createEngine, createSceneContext, createDefaultCamera, attachControl, createPbrMaterial, createPointLight, createSphere, createBox, createSolidTexture2D, loadGltf, loadTexture2D, registerScene } from "babylon-lite";
import { loadDdsEnvironment } from "babylon-lite/loader-env/load-dds-env";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Image processing: ACES tone mapping, exposure 1.6
    scene.imageProcessing.exposure = 1.6;
    scene.imageProcessing.toneMappingEnabled = true;
    scene.imageProcessing.toneMappingType = "aces";

    // seekTime support for parity testing
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");

    // Load dragon model + thickness texture in parallel
    const root = "https://assets.babylonjs.com/meshes/Georgia-Tech-Dragon/";
    const [container, thicknessTexture] = await Promise.all([loadGltf(engine, root + "dragonUV.glb"), loadTexture2D(engine, root + "thicknessMap.png", { invertY: false })]);

    // Create PBR material with subsurface translucency
    // albedoColor = #40F7E0 in linear space (sRGB → linear via pow(x/255, 2.2))
    const albedoR = Math.pow(0x40 / 255, 2.2);
    const albedoG = Math.pow(0xf7 / 255, 2.2);
    const albedoB = Math.pow(0xe0 / 255, 2.2);

    const baseColorTex = createSolidTexture2D(engine, albedoR, albedoG, albedoB);
    const ormTex = createSolidTexture2D(engine, 1.0, 0.16, 0.0); // occ=1, rough=0.16, metal=0

    const dragonMaterial = createPbrMaterial({
        baseColorTexture: baseColorTex,
        ormTexture: ormTex,
        enableSpecularAA: true,
        subsurface: {
            translucency: {
                intensity: 1.0,
                color: [1, 1, 1],
                diffusionDistance: [1, 1, 1],
            },
            thickness: {
                texture: thicknessTexture,
                min: 0,
                max: 2.2,
            },
        },
    });

    // Add meshes to scene, then override material
    addToScene(scene, container);
    for (const m of scene.meshes) {
        m.material = dragonMaterial;
    }

    // Tiny emissive sphere (BJS scene has this for the orbiting point light — affects auto-framing bounds)
    const lightSphere = createSphere(engine, { segments: 32, diameter: 0.005 });
    lightSphere.boundMin = [0, 0.02 - 0.0025, -0.2 - 0.0025];
    lightSphere.boundMax = [0, 0.02 + 0.0025, -0.2 + 0.0025];
    lightSphere.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 1.0, 0.0),
        emissiveColor: [1, 1, 1],
    });
    addToScene(scene, lightSphere);

    // Camera: use createDefaultCamera to auto-frame, then add PI to alpha
    const cam = createDefaultCamera(scene);
    cam.alpha += Math.PI;
    attachControl(cam, canvas, scene);

    // Point light (very low intensity, orbits via pivot offset)
    const pointLight = createPointLight([0, 0.02, -0.2], 0.01);
    addToScene(scene, pointLight);

    // Environment: DDS cubemap (same file as BJS) for IBL, no auto-skybox
    await loadDdsEnvironment(scene, "https://playground.babylonjs.com/textures/environment.dds", {
        brdfUrl: "/brdf-lut.png",
    });

    // Skybox: PBR skybox mode — samples cubemap using view direction (like BJS SKYBOX_MODE)
    // BJS skybox has vReflectivityColor=(1,1,1) → F0=1, matching metallic=1 with white baseColor.
    // roughness=0.3 (microSurface=0.7), no direct lighting, double-sided
    const skybox = createBox(engine, 5);
    skybox.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.3, 1.0), // occ=1, rough=0.3, metal=1 → F0=(1,1,1)
        environmentIntensity: 1.008,
        directIntensity: 0,
        doubleSided: true,
        skyboxMode: true,
    });
    const syncSkybox = (): void => {
        const w = cam.worldMatrix;
        skybox.position.set(w[12]!, w[13]!, w[14]!);
    };
    syncSkybox();
    onBeforeRender(scene, syncSkybox);
    addToScene(scene, skybox);

    // Handle seekTime
    let rotY = 0;
    const updateOrbit = (): void => {
        const cosR = Math.cos(rotY);
        const sinR = Math.sin(rotY);
        const px = 0,
            pz = -0.2;
        const wx = px * cosR + pz * sinR;
        const wz = -px * sinR + pz * cosR;
        pointLight.position.x = wx;
        pointLight.position.z = wz;
        lightSphere.position.x = wx;
        lightSphere.position.y = 0.02;
        lightSphere.position.z = wz;
    };
    if (!isNaN(seekTimeParam)) {
        if (seekTimeParam > 0) {
            const seekFrames = seekTimeParam * 60;
            for (let f = 0; f < seekFrames; f++) {
                rotY += 0.01;
            }
            updateOrbit();
        }
        canvas.dataset.animationFrozen = "true";
    } else {
        // Animate light orbit per-frame
        onBeforeRender(scene, () => {
            rotY += 0.01;
            updateOrbit();
        });
    }

    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

void main();
