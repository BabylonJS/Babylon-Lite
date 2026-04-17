import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import "@babylonjs/core/Materials/standardMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
// Force KTX1 texture loader registration before scene.whenReadyAsync() —
// without this, the loader is registered via dynamic import on first use and
// scene.whenReadyAsync() may resolve before the compressed upload completes,
// leaving the diffuse sampler bound to a black fallback (observed on
// BrowserStack macOS Sonoma WebGPU).
import "@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, enableAllFeatures: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);

    const camera = new FreeCamera("camera1", new Vector3(0, 5, -10), scene);
    camera.setTarget(Vector3.Zero());
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light1", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const ground = MeshBuilder.CreateGround("ground1", { width: 6, height: 6, subdivisions: 2 }, scene);

    // Pick best KTX format based on GPU caps, fallback to PNG
    const caps = engine.getCaps();
    const base = "https://raw.githubusercontent.com/Vinc3r/BJS-KTX-textures/master/BJS/UVgrid";
    let texUrl = base + ".png";
    if (caps.astc) {
        texUrl = base + "-astc.ktx";
    } else if (caps.s3tc) {
        texUrl = base + "-dxt.ktx";
    } else if (caps.etc2) {
        texUrl = base + "-etc2.ktx";
    }

    const materialPlane = new StandardMaterial("texturePlane", scene);
    materialPlane.diffuseTexture = new Texture(texUrl, scene);
    materialPlane.diffuseTexture.uScale = 2.0;
    materialPlane.diffuseTexture.vScale = 2.0;

    ground.material = materialPlane;

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
