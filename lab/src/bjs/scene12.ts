import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

void (async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = Color3.FromInts(20, 20, 25) as any;

    const server = "https://assets.babylonjs.com/";

    const camera = new ArcRotateCamera("camera", Math.PI / 2, Math.PI / 2, 15, new Vector3(0, 0, 0), scene);
    camera.minZ = 0.1;
    camera.wheelDeltaPercentage = 0.1;
    camera.attachControl(canvas, true);

    const envTex = CubeTexture.CreateFromPrefilteredData("/textures/Studio_Softbox_2Umbrellas_cube_specular.env", scene);
    envTex.name = "studioIBL";
    envTex.gammaSpace = false;
    envTex.rotationY = 1.9;
    scene.environmentTexture = envTex;
    scene.environmentIntensity = 1.0;

    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_STANDARD;
    scene.imageProcessingConfiguration.exposure = 0.8;
    scene.imageProcessingConfiguration.contrast = 1.2;

    const dirLight = new DirectionalLight("dirLight", new Vector3(0.45, -0.34, -0.83), scene);
    dirLight.position = new Vector3(0, 3, 5);
    dirLight.shadowMinZ = 3.5;
    dirLight.shadowMaxZ = 12;

    const result = await SceneLoader.ImportMeshAsync("", server + "meshes/Demos/pbr_mr_specular/", "shaderBall_rotation.glb", scene);
    const middleRoot = result.meshes[0];
    middleRoot.name = "shaderBallMiddleRoot";
    for (const m of middleRoot.getChildMeshes()) {
        if (m.material) {
            m.material.dispose();
        }
    }

    const upperRoot = middleRoot.clone("shaderBallUpperRoot", null)!;
    upperRoot.position.y = 3;

    const lowerRoot = middleRoot.clone("shaderBallLowerRoot", null)!;
    lowerRoot.position.y = -3;

    const [reflectanceTex, metallicReflectanceTex] = await Promise.all([
        new Promise<Texture>((resolve) => {
            const tex = new Texture(server + "meshes/Demos/pbr_mr_specular/reflectanceColorTex.png", scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
            tex.onLoadObservable.addOnce(() => resolve(tex));
        }),
        new Promise<Texture>((resolve) => {
            const tex = new Texture(server + "meshes/Demos/pbr_mr_specular/metallicReflectanceTex.png", scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
            tex.onLoadObservable.addOnce(() => resolve(tex));
        }),
    ]);

    const matUpper = new PBRMaterial("shaderBallUpper", scene);
    matUpper.albedoColor = Color3.FromInts(50, 50, 50).toLinearSpace();
    matUpper.metallic = 0.0;
    matUpper.roughness = 0.15;
    matUpper.metallicF0Factor = 0.95;
    matUpper.metallicReflectanceColor = Color3.FromInts(255, 250, 250).toLinearSpace();
    matUpper.metallicReflectanceTexture = metallicReflectanceTex;

    const matMiddle = new PBRMaterial("shaderBallMiddle", scene);
    matMiddle.albedoColor = Color3.FromInts(50, 50, 50).toLinearSpace();
    matMiddle.metallic = 0.0;
    matMiddle.roughness = 0.15;
    matMiddle.metallicF0Factor = 0.95;
    matMiddle.metallicReflectanceColor = Color3.FromInts(255, 250, 250).toLinearSpace();
    matMiddle.reflectanceTexture = reflectanceTex;

    const matLower = new PBRMaterial("shaderBallLower", scene);
    matLower.albedoColor = Color3.FromInts(50, 50, 50).toLinearSpace();
    matLower.metallic = 0.0;
    matLower.roughness = 0.15;
    matLower.metallicF0Factor = 0.95;
    matLower.metallicReflectanceColor = Color3.FromInts(255, 250, 250).toLinearSpace();
    matLower.metallicReflectanceTexture = metallicReflectanceTex;
    matLower.reflectanceTexture = reflectanceTex;
    matLower.useOnlyMetallicFromMetallicReflectanceTexture = true;

    for (const m of upperRoot.getChildMeshes()) {
        m.material = matUpper;
    }
    for (const m of middleRoot.getChildMeshes()) {
        m.material = matMiddle;
    }
    for (const m of lowerRoot.getChildMeshes()) {
        m.material = matLower;
    }

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");

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

    let frameCount = 0;
    let seekDone = false;
    scene.onBeforeRenderObservable.add(() => {
        frameCount++;
        if (!isNaN(seekTimeParam) && seekTimeParam > 0 && frameCount === 10 && !seekDone) {
            scene.animationGroups.forEach((g) => {
                const range = g.to - g.from;
                if (range > 0) {
                    const seekFrame = g.from + ((seekTimeParam * 60 - g.from) % range);
                    g.goToFrame(seekFrame);
                }
            });
            scene.animatables.forEach((a) => a.pause());
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    let readyCount = 0;
    scene.onAfterRenderObservable.add(() => {
        readyCount++;
        if (readyCount >= 2) {
            canvas.dataset.initMs = String(performance.now() - __initStart);
            canvas.dataset.ready = "true";
        }
    });

    window.addEventListener("resize", () => engine.resize());
})();
