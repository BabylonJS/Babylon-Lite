import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Helpers/sceneHelpers";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = Color3.Black() as any;

    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(
        "https://assets.babylonjs.com/core/environments/environmentSpecular.env",
        scene
    );

    const cam = new ArcRotateCamera("cam", 0, Math.PI / 2, 5, Vector3.Zero(), scene);
    cam.lowerRadiusLimit = 2;
    cam.upperRadiusLimit = 10;
    cam.attachControl(canvas, true);

    const sphere = Mesh.CreateSphere("sphere", 128, 2, scene);

    const pbr = new PBRMaterial("pbr", scene);
    sphere.material = pbr;

    pbr.metallic = 1.0;
    pbr.roughness = 0.0;

    pbr.anisotropy.isEnabled = true;

    // seekTime support: freeze animation at a deterministic pose
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frozen = false;
    let a = 0;

    scene.useConstantAnimationDeltaTime = true;

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
                a += 0.01;
                pbr.anisotropy.intensity = Math.cos(a) * 0.5 + 0.5;
            }
            frozen = true;
            canvas.dataset.animationFrozen = "true";
            return;
        }

        a += 0.01;
        pbr.anisotropy.intensity = Math.cos(a) * 0.5 + 0.5;
    });

    scene.createDefaultEnvironment();

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
