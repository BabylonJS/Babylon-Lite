import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const ROOT = "https://assets.babylonjs.com/meshes/BentNormalTest/";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    const container = await SceneLoader.LoadAssetContainerAsync(ROOT, "bent_normal_test.gltf", scene);
    const bent = new Texture(ROOT + "bent_normal_low_bent_normal_mat_BentNormal_OpenGL.png", scene, { invertY: false, gammaSpace: false });
    for (let index = 0; index < 2; index++) {
        const model = container.instantiateModelsToScene((name) => name + index, true, { doNotInstantiate: true });
        (model.rootNodes[0] as AbstractMesh).position.x = index === 0 ? -0.007 : 0.007;
        const mesh = (model.rootNodes[0] as AbstractMesh).getChildMeshes().find((candidate) => candidate.getTotalVertices() > 0)!;
        if (index === 1) {
            // `bentNormalTexture` landed in Babylon.js after the pinned npm release; the golden was
            // captured from the BabylonJS/Babylon.js#19069 build. Refuse to render (and silently
            // recapture a wrong golden) with a Babylon.js build that ignores the property.
            if (!("bentNormalTexture" in mesh.material!)) {
                throw new Error("This Babylon.js build has no PBRMaterial.bentNormalTexture support (needs BabylonJS/Babylon.js#19069)");
            }
            (mesh.material as unknown as { bentNormalTexture: Texture }).bentNormalTexture = bent;
        }
    }

    scene.createDefaultEnvironment({ createGround: false, createSkybox: false });
    scene.clearColor = new Color4(0.12, 0.12, 0.12, 1);

    const camera = new ArcRotateCamera("camera", -1.35, 0.85, 0.037, new Vector3(0, 0.00172, 0), scene);
    camera.minZ = 0.00001;
    camera.maxZ = 1;
    camera.attachControl(canvas, true);

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
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
