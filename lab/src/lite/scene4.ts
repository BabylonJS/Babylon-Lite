// Scene 4: Shadows — matches Babylon #IIZ9UU

import { onBeforeRender, addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createDirectionalLight, createSpotLight, createTorus, createSphere, createGroundFromHeightMap, createShadowGenerator, createPcfShadowGenerator, createStandardMaterial, loadTexture2D, attachControl, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const cam = createArcRotateCamera(0, 0.8, 90, { x: 0, y: 0, z: 0 });
    cam.nearPlane = 0.1;
    cam.farPlane = 1000;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    const light = createDirectionalLight([-1, -2, -1]);
    light.position.set(20, 40, 20);
    addToScene(scene, light);

    // Torus at (30, 30, 0) — shadow caster
    const torus = createTorus(engine, { diameter: 4, thickness: 2, tessellation: 30 });
    torus.material = createStandardMaterial();
    torus.position.set(30, 30, 0);
    addToScene(scene, torus);

    // Sphere at light position — emissive yellow
    const sphere = createSphere(engine, { segments: 10, diameter: 2 });
    sphere.material = createStandardMaterial();
    sphere.position.set(20, 40, 20);
    sphere.material.emissiveColor = [1, 1, 0];
    addToScene(scene, sphere);

    // Ground from heightmap — receives shadows
    const ground = await createGroundFromHeightMap(engine, "https://playground.babylonjs.com/textures/heightMap.png", {
        width: 100,
        height: 100,
        subdivisions: 100,
        minHeight: 0,
        maxHeight: 10,
    });
    ground.position.set(0, -2.05, 0);
    ground.material = createStandardMaterial();
    ground.material.specularColor = [0, 0, 0];
    ground.material.diffuseTexture = await loadTexture2D(engine, "https://playground.babylonjs.com/textures/ground.jpg");
    ground.material.uvScale = [6, 6];
    ground.receiveShadows = true;
    addToScene(scene, ground);

    // Shadow generator — torus casts shadows (directional light, ESM blur)
    light.shadowGenerator = createShadowGenerator(engine, light, [torus], {
        mapSize: 1024,
        depthScale: 50,
        bias: 0.00005,
        blurKernel: 64,
        blurScale: 2,
        darkness: 0,
        frustumEdgeFalloff: 0,
        orthoMinZ: cam.nearPlane,
        orthoMaxZ: cam.farPlane,
    });

    // Second light: SpotLight with PCF shadows (tests multi-light shadow support)
    const spot = createSpotLight([48.8, 50, 6.8], [-18.8, -20, -6.8], 1.5, 12);
    spot.intensity = 0.8;
    addToScene(scene, spot);

    spot.shadowGenerator = createPcfShadowGenerator(engine, spot, [torus], {
        mapSize: 512,
        near: cam.nearPlane,
        far: cam.farPlane,
    });

    // Emissive sphere to visualize spotlight position
    const spotSphere = createSphere(engine, { diameter: 2 });
    spotSphere.position.set(48.8, 50, 6.8);
    spotSphere.material = createStandardMaterial();
    spotSphere.material.emissiveColor = [0, 0.5, 1];
    spotSphere.material.disableLighting = true;
    addToScene(scene, spotSphere);

    // --- Interactive: toggle torus rotation ---
    let rotatingTorus = false;
    // --- Interactive: orbit spotlight around torus on XZ plane ---
    let orbitingSpot = false;
    let spotAngle = (20 * Math.PI) / 180;
    const spotOrbitRadius = 20;
    const spotCenterX = 30; // orbit around torus X
    const spotY = 50;
    onBeforeRender(scene, () => {
        if (rotatingTorus) {
            torus.rotation.x += 0.01;
            torus.rotation.y += 0.02;
        }
        if (orbitingSpot) {
            spotAngle += 0.01;
            const x = spotCenterX + Math.cos(spotAngle) * spotOrbitRadius;
            const z = Math.sin(spotAngle) * spotOrbitRadius;
            spot.position.set(x, spotY, z);
            // Always point at torus position
            spot.direction.set(30 - x, 30 - spotY, -z);
            spotSphere.position.set(x, spotY, z);
        }
    });
    const btnStyle =
        "position:absolute;bottom:12px;padding:8px 16px;font:14px sans-serif;cursor:pointer;z-index:10;background:#333;color:#fff;border:1px solid #666;border-radius:4px;";
    const btnRotate = document.createElement("button");
    btnRotate.textContent = "Rotate Torus: OFF";
    btnRotate.setAttribute("style", btnStyle + "left:calc(50% - 120px);");
    btnRotate.addEventListener("click", () => {
        rotatingTorus = !rotatingTorus;
        btnRotate.textContent = `Rotate Torus: ${rotatingTorus ? "ON" : "OFF"}`;
    });
    document.body.appendChild(btnRotate);

    const btnOrbit = document.createElement("button");
    btnOrbit.textContent = "Orbit Spot: OFF";
    btnOrbit.setAttribute("style", btnStyle + "left:calc(50% + 20px);");
    btnOrbit.addEventListener("click", () => {
        orbitingSpot = !orbitingSpot;
        btnOrbit.textContent = `Orbit Spot: ${orbitingSpot ? "ON" : "OFF"}`;
    });
    document.body.appendChild(btnOrbit);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
