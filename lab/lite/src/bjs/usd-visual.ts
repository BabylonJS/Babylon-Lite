import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { AppendSceneAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/USD/usdFileLoader";
import { createUsdVisualSource, type UsdVisualAsset } from "../shared/usd-visual-stages.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const asset = (new URLSearchParams(location.search).get("asset") ?? "materials") as UsdVisualAsset;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = () => {};
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.05, 0.08, 1);
    const target = asset === "materials" ? new Vector3(0.5, 0.5, 0) : new Vector3(0, 1.1, 0);
    new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2.65, asset === "materials" ? 6 : 6.5, target, scene);
    new HemisphericLight("light", new Vector3(0.25, 1, 0.2), scene).intensity = 1.1;

    await AppendSceneAsync(createUsdVisualSource(asset), scene);
    if (asset === "skin" && scene.animationGroups[0]) {
        scene.animationGroups[0].goToFrame(12);
        scene.animationGroups[0].pause();
    }

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.ready = "true";
}

void main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
