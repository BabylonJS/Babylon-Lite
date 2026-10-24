// Scene 318 — BJS reference for the glTF export "Morph Target Animation" test.
// Mirrors playground #84M2SR#107 (Babylon.js visualization test "GLTF Serializer Morph Target Animation"):
// a textured sphere with two animated morph targets, exported with GLTF2Export, reloaded with SceneLoader and
// both animation groups started on frame 60 (from = to = 60).
import { Animation } from "@babylonjs/core/Animations/animation";
import "@babylonjs/core/Animations/animatable";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Helpers/sceneHelpers";
// The serializer encodes textures with a WebGL "pass" effect (DumpTools) that needs the default post-process vertex shader registered.
import "@babylonjs/core/Shaders/postprocess.vertex";
import { GLTF2Export } from "@babylonjs/serializers/glTF/2.0";
import "@babylonjs/loaders/glTF";
import { GLTFLoaderAnimationStartMode } from "@babylonjs/loaders/glTF/glTFFileLoader";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";

// Babylon.js visualization harness: seeded Math.random (installed after the engine exists, right before the snippet runs).
let seed = 1;
const installSeededRandom = () => {
    seed = 1;
    Math.random = () => {
        const x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    };
};

// The snippet passes `{ segments: 16, size: 2 }`; CreateSphere has no `size` option, so it is ignored and the spheres keep the default diameter 1.
const SPHERE_OPTIONS = { segments: 16, size: 2 } as { segments: number };

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const params = new URLSearchParams(location.search);
    const antialias = params.get("antialias") !== "0";
    const engine = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: true });
    await engine.initAsync();
    SceneLoader.ShowLoadingScreen = false;
    engine.displayLoadingUI = () => {};

    installSeededRandom();
    const scene = new Scene(engine);

    const sphere1 = MeshBuilder.CreateSphere("sphere1", SPHERE_OPTIONS, scene);
    const mat = new StandardMaterial("mat", scene);
    mat.diffuseTexture = new Texture("https://playground.babylonjs.com/textures/misc.jpg", scene);
    sphere1.material = mat;

    const sphere2 = MeshBuilder.CreateSphere("sphere2", SPHERE_OPTIONS, scene);
    sphere2.setEnabled(false);
    sphere2.updateMeshPositions((positions) => {
        for (let i = 0; i < positions.length; i++) {
            positions[i] = positions[i]! + 0.2 * Math.random();
        }
    });

    const sphereYStretched = MeshBuilder.CreateSphere("sphereYStretch", SPHERE_OPTIONS, scene);
    sphereYStretched.setEnabled(false);
    sphereYStretched.scaling = new Vector3(1, 3, 1);
    sphereYStretched.updateMeshPositions((positions) => {
        const scaling = sphereYStretched.scaling;
        for (let i = 0; i < positions.length; i += 3) {
            const v = Vector3.FromArray(positions, i);
            v.x *= scaling.x;
            v.y *= scaling.y;
            v.z *= scaling.z;
            v.toArray(positions, i);
        }
    });

    const manager = new MorphTargetManager();
    sphere1.morphTargetManager = manager;
    const target0 = MorphTarget.FromMesh(sphere2, "sphere2", 0.25);
    manager.addTarget(target0);
    const target1 = MorphTarget.FromMesh(sphereYStretched, "sphereYStretched", 0.25);
    manager.addTarget(target1);
    sphere2.dispose();
    sphereYStretched.dispose();

    const animation0 = new Animation("sphereMorphTarget0_animation", "influence", 24, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
    animation0.setKeys([
        { frame: 0, value: 0 },
        { frame: 24, value: 1 },
        { frame: 48, value: 0 },
    ]);
    target0.animations.push(animation0);

    const animation1 = new Animation("sphereMorphTarget1_animation", "influence", 24, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
    animation1.setKeys([
        { frame: 0, value: 1 },
        { frame: 12, value: 0 },
        { frame: 24, value: 1 },
        { frame: 36, value: 0 },
        { frame: 48, value: 1 },
    ]);
    target1.animations.push(animation1);

    const assetName = "morphTargetTest";
    const glbData = await GLTF2Export.GLBAsync(scene, assetName);
    scene.dispose();
    const file = new File([glbData.glTFFiles[assetName + ".glb"]!], assetName + ".glb");

    SceneLoader.OnPluginActivatedObservable.addOnce((loader) => {
        (loader as unknown as { animationStartMode: number }).animationStartMode = GLTFLoaderAnimationStartMode.NONE;
    });
    const outScene = await SceneLoader.LoadAsync("file:", file, engine);
    outScene.createDefaultCameraOrLight(true, true, true);
    (outScene.activeCamera as ArcRotateCamera).radius *= 2;
    outScene.animationGroups[0]!.start(true, 1, 60, 60, true);
    outScene.animationGroups[0]!.setWeightForAllAnimatables(1);
    outScene.animationGroups[1]!.start(true, 1, 60, 60, true);
    outScene.animationGroups[1]!.setWeightForAllAnimatables(1);
    outScene.useConstantAnimationDeltaTime = true;

    await outScene.whenReadyAsync();
    engine.runRenderLoop(() => outScene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => outScene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
});
