import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const cam = new ArcRotateCamera("cam", 0, 0.8, 90, new Vector3(0, 0, 0), scene);
    cam.minZ = 0.1;
    cam.maxZ = 1000;
    cam.attachControl(canvas, true);

    const light = new DirectionalLight("dir", new Vector3(-1, -2, -1), scene);
    light.position = new Vector3(20, 40, 20);

    const torus = MeshBuilder.CreateTorus("torus", { diameter: 4, thickness: 2, tessellation: 30 }, scene);
    torus.position = new Vector3(30, 30, 0);

    const sphere = MeshBuilder.CreateSphere("sphere", { segments: 10, diameter: 2 }, scene);
    sphere.position = new Vector3(20, 40, 20);
    const emissiveMat = new StandardMaterial("emissive", scene);
    emissiveMat.emissiveColor = new Color3(1, 1, 0);
    sphere.material = emissiveMat;

    const ground = MeshBuilder.CreateGroundFromHeightMap(
        "ground",
        "https://playground.babylonjs.com/textures/heightMap.png",
        { width: 100, height: 100, subdivisions: 100, minHeight: 0, maxHeight: 10 },
        scene
    );
    ground.position.y = -2.05;
    ground.receiveShadows = true;

    const gmat = new StandardMaterial("groundMat", scene);
    gmat.specularColor = new Color3(0, 0, 0);
    gmat.diffuseTexture = new Texture("https://playground.babylonjs.com/textures/ground.jpg", scene);
    (gmat.diffuseTexture as Texture).uScale = 6;
    (gmat.diffuseTexture as Texture).vScale = 6;
    ground.material = gmat;

    await scene.whenReadyAsync();

    const shadowGen = new ShadowGenerator(1024, light);
    shadowGen.useBlurExponentialShadowMap = true;
    shadowGen.useKernelBlur = true;
    shadowGen.blurKernel = 64;
    shadowGen.addShadowCaster(torus);

    // Second light: SpotLight with PCF shadows (tests multi-light shadow support)
    const spot = new SpotLight("spot", new Vector3(48.8, 50, 6.8), new Vector3(-18.8, -20, -6.8).normalize(), 1.5, 12, scene);
    spot.intensity = 0.8;
    const spotShadowGen = new ShadowGenerator(512, spot);
    spotShadowGen.usePercentageCloserFiltering = true;
    spotShadowGen.addShadowCaster(torus);

    // Emissive sphere to visualize spotlight position
    const spotSphere = MeshBuilder.CreateSphere("spotSphere", { diameter: 2 }, scene);
    spotSphere.position = spot.position.clone();
    const spotSphereMat = new StandardMaterial("spotSphereMat", scene);
    spotSphereMat.emissiveColor = new Color3(0, 0.5, 1);
    spotSphereMat.disableLighting = true;
    spotSphere.material = spotSphereMat;

    // --- Interactive: toggle torus rotation ---
    let rotatingTorus = false;
    // --- Interactive: orbit spotlight around torus on XZ plane ---
    let orbitingSpot = false;
    let spotAngle = (20 * Math.PI) / 180;
    const spotOrbitRadius = 20;
    const spotCenterX = 30; // orbit around torus X
    const spotY = 50;
    scene.onBeforeRenderObservable.add(() => {
        if (rotatingTorus) {
            torus.rotation.x += 0.01;
            torus.rotation.y += 0.02;
        }
        if (orbitingSpot) {
            spotAngle += 0.01;
            const x = spotCenterX + Math.cos(spotAngle) * spotOrbitRadius;
            const z = Math.sin(spotAngle) * spotOrbitRadius;
            spot.position = new Vector3(x, spotY, z);
            // Always point at torus position
            spot.direction = new Vector3(30 - x, 30 - spotY, -z).normalize();
            spotSphere.position = spot.position.clone();
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

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
