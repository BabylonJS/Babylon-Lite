// Scene 26 — PBR Subsurface / Translucency
// Based on playground #5H0H89#5 (Georgia Tech Dragon with subsurface translucency)
//
// Simplifications for parity:
// - seekTime support to freeze the orbiting light at a deterministic pose
// - No PrePass/SSS (isScatteringEnabled=false) — translucency only

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import "@babylonjs/core/Meshes/meshBuilder";
import "@babylonjs/core/Loading/loadingScreen";
import { Scene } from "@babylonjs/core/scene";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF/2.0/glTFLoader";
import "@babylonjs/core/Materials/Textures/Loaders/ddsTextureLoader";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Helpers/sceneHelpers";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    // Environment texture (DDS cubemap)
    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(
        "https://playground.babylonjs.com/textures/environment.dds",
        scene
    );

    // Image processing: ACES tone mapping, exposure 1.6
    scene.imageProcessingConfiguration.exposure = 1.6;
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;

    // seekTime support
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frozen = false;

    // Emissive light-marker sphere (tiny, just carries the point light)
    const lightSphere = Mesh.CreateSphere("sphere", 32, 0.005, scene);
    const lightSphereMat = new PBRMaterial("lightSphereMat", scene);
    lightSphereMat.roughness = 1.0;
    lightSphereMat.metallic = 0.0;
    lightSphereMat.emissiveColor = new Color3(1, 1, 1);
    lightSphere.material = lightSphereMat;
    lightSphere.setPivotMatrix(Matrix.Translation(0, 1 / 50, -4 / 20), false);

    // Point light attached to the sphere
    const light = new PointLight("point", lightSphere.position, scene);
    light.diffuse = new Color3(1, 1, 1);
    light.specular = new Color3(1, 1, 1);
    light.intensity = 0.01;

    // Load dragon model
    const root = "https://assets.babylonjs.com/meshes/Georgia-Tech-Dragon/";
    await SceneLoader.AppendAsync(root, "dragonUV.glb", scene);

    const dragonMesh = scene.getMeshByID("dragonLR")!;
    const mat = dragonMesh.material as PBRMaterial;
    mat.metallic = 0;
    mat.roughness = 0.160;
    mat.albedoColor = Color3.FromHexString("#40F7E0").toLinearSpace();

    // Subsurface / translucency (no scattering — skip PrePass for parity)
    mat.subSurface.thicknessTexture = new Texture(root + "thicknessMap.png", scene, false, false);
    mat.subSurface.maximumThickness = 2.2;
    mat.subSurface.isTranslucencyEnabled = true;
    // Scattering disabled — no PrePass needed for phase 1 parity

    // Camera — auto-frame the dragon
    scene.createDefaultCamera(true, true, true);
    const cam = scene.activeCamera as ArcRotateCamera;
    cam.alpha += Math.PI;

    // HDR skybox
    const hdrSkybox = Mesh.CreateBox("hdrSkyBox", 5, scene, false, Constants.MATERIAL_CounterClockWiseSideOrientation);
    const hdrSkyboxMaterial = new PBRMaterial("skyBox", scene);
    hdrSkyboxMaterial.backFaceCulling = false;
    hdrSkyboxMaterial.reflectionTexture = scene.environmentTexture!.clone();
    if (hdrSkyboxMaterial.reflectionTexture) {
        hdrSkyboxMaterial.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
    }
    hdrSkyboxMaterial.microSurface = 0.7;
    hdrSkyboxMaterial.disableLighting = true;
    hdrSkyboxMaterial.twoSidedLighting = true;
    hdrSkybox.infiniteDistance = true;
    hdrSkybox.material = hdrSkyboxMaterial;

    // Animation: orbit the light sphere around the dragon
    scene.useConstantAnimationDeltaTime = true;
    let rotY = 0;

    scene.onBeforeRenderObservable.add(() => {
        if (frozen) {
            return;
        }

        if (!isNaN(seekTimeParam)) {
            if (seekTimeParam === 0) {
                frozen = true;
                canvas.dataset.animationFrozen = "true";
                return;
            }
            const seekFrames = seekTimeParam * 60;
            for (let f = 0; f < seekFrames; f++) {
                rotY += 0.01;
            }
            lightSphere.rotation.y = rotY;
            light.position = lightSphere.getAbsolutePosition();
            frozen = true;
            canvas.dataset.animationFrozen = "true";
            return;
        }

        rotY += 0.01;
        lightSphere.rotation.y = rotY;
        light.position = lightSphere.getAbsolutePosition();
    });

    // Draw call tracking
    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
