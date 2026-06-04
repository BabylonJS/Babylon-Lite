// Babylon.js reference for Scene 213: GridMaterial oracle.
//
// Mirrors lab/lite/src/lite/scene213.ts exactly — same WebGPU engine MSAA (4x via
// antialias:true), same ArcRotateCamera (alpha/beta/radius/target/near/far/fov),
// the same four meshes (ground / sphere / transparent box / hard-cutoff box), and
// the identical @babylonjs/materials GridMaterial parameters per mesh. No lights,
// no fog, no clip planes — fully static and deterministic.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { Scene } from "@babylonjs/core/scene";
import { GridMaterial } from "@babylonjs/materials/grid/gridMaterial";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.08, 0.08, 0.11, 1);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2.3, Math.PI / 3.0, 16, new Vector3(0, 1.2, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 200;
    camera.attachControl(canvas, true);

    // Large opaque ground grid: dark main color, teal lines.
    const ground = CreateGround("ground", { width: 14, height: 14 }, scene);
    const groundGrid = new GridMaterial("groundGrid", scene);
    groundGrid.mainColor = new Color3(0.06, 0.07, 0.1);
    groundGrid.lineColor = new Color3(0, 0.5, 0.5);
    groundGrid.gridRatio = 1;
    groundGrid.majorUnitFrequency = 10;
    groundGrid.minorUnitVisibility = 0.45;
    groundGrid.antialias = true;
    ground.material = groundGrid;

    // Sphere using useMaxLine to show the object-space grid on a curved surface.
    const sphere = CreateSphere("sphere", { segments: 48, diameter: 3 }, scene);
    sphere.position.set(-3.6, 1.6, 0);
    const sphereGrid = new GridMaterial("sphereGrid", scene);
    sphereGrid.mainColor = new Color3(0.1, 0.05, 0.05);
    sphereGrid.lineColor = new Color3(1.0, 0.55, 0.1);
    sphereGrid.gridRatio = 0.5;
    sphereGrid.majorUnitFrequency = 5;
    sphereGrid.minorUnitVisibility = 0.5;
    sphereGrid.useMaxLine = true;
    sphereGrid.antialias = true;
    sphere.material = sphereGrid;

    // Transparent box exercising the alpha-blend path. Lite's GridMaterial models the
    // classic lines-only transparency (opacity = clamp(grid, 0.08, opacity*grid)),
    // which @babylonjs/materials 9.x exposes behind the `linesOnly` flag.
    const box = CreateBox("box", { size: 2.4 }, scene);
    box.position.set(3.6, 1.2, 0);
    const boxGrid = new GridMaterial("boxGrid", scene);
    boxGrid.linesOnly = true;
    boxGrid.mainColor = new Color3(0.05, 0.08, 0.12);
    boxGrid.lineColor = new Color3(0.2, 0.9, 1.0);
    boxGrid.gridRatio = 0.5;
    boxGrid.majorUnitFrequency = 4;
    boxGrid.minorUnitVisibility = 0.4;
    boxGrid.opacity = 0.6;
    boxGrid.antialias = true;
    box.material = boxGrid;

    // Small box with antialias=false to cover the hard-cutoff line path.
    const hardBox = CreateBox("hardBox", { size: 1.6 }, scene);
    hardBox.position.set(0, 0.8, 3.4);
    const hardGrid = new GridMaterial("hardGrid", scene);
    hardGrid.mainColor = new Color3(0.08, 0.05, 0.1);
    hardGrid.lineColor = new Color3(0.9, 0.2, 0.6);
    hardGrid.gridRatio = 0.3;
    hardGrid.majorUnitFrequency = 3;
    hardGrid.minorUnitVisibility = 0.6;
    hardGrid.antialias = false;
    hardBox.material = hardGrid;

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
