// Scene 38 — BJS reference for procedural builders parity.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
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

    const cam = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 3, 14, new Vector3(0, 0, 0), scene);
    cam.minZ = 0.5;
    cam.maxZ = 1000;

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.7;
    const dir = new DirectionalLight("dir", new Vector3(-0.5, -1, 0.3), scene);
    dir.diffuse = new Color3(0.9, 0.9, 0.9);

    const col = (r: number, g: number, b: number) => {
        const m = new StandardMaterial("m", scene);
        m.diffuseColor = new Color3(r, g, b);
        return m;
    };

    const cyl = MeshBuilder.CreateCylinder("cyl", { height: 2, diameter: 1, tessellation: 24 }, scene);
    cyl.position = new Vector3(-6, 0, 0);
    cyl.material = col(0.8, 0.3, 0.3);

    const cone = MeshBuilder.CreateCylinder("cone", { height: 2, diameterTop: 0, diameterBottom: 1.2, tessellation: 24 }, scene);
    cone.position = new Vector3(-4, 0, 0);
    cone.material = col(0.9, 0.6, 0.2);

    const plane = MeshBuilder.CreatePlane("plane", { size: 1.5 }, scene);
    plane.position = new Vector3(-2, 0, 0);
    plane.material = col(0.2, 0.7, 0.3);

    const disc = MeshBuilder.CreateDisc("disc", { radius: 0.9, tessellation: 32 }, scene);
    disc.position = new Vector3(0, 0, 0);
    disc.material = col(0.3, 0.3, 0.85);

    const ring = MeshBuilder.CreateDisc("ring", { radius: 0.9, tessellation: 48, arc: 0.7 }, scene);
    ring.position = new Vector3(2, 0, 0);
    ring.material = col(0.85, 0.3, 0.85);

    const ico = MeshBuilder.CreatePolyhedron("ico", { type: 3, size: 0.8 }, scene);
    ico.position = new Vector3(4, 0, 0);
    ico.material = col(0.3, 0.85, 0.85);

    const ribbonPaths: Vector3[][] = [];
    for (let p = 0; p < 3; p++) {
        const row: Vector3[] = [];
        for (let i = 0; i < 16; i++) {
            const t = i / 15;
            row.push(new Vector3(t * 1.5 - 0.75, Math.sin(t * Math.PI * 2) * 0.15, (p - 1) * 0.3));
        }
        ribbonPaths.push(row);
    }
    const ribbon = MeshBuilder.CreateRibbon("ribbon", { pathArray: ribbonPaths }, scene);
    ribbon.position = new Vector3(6, 0, 0);
    ribbon.material = col(0.85, 0.85, 0.3);

    const tubePath: Vector3[] = [];
    for (let i = 0; i < 24; i++) {
        const t = i / 23;
        tubePath.push(new Vector3(Math.cos(t * Math.PI * 2) * 0.5, t * 1.5 - 0.75, Math.sin(t * Math.PI * 2) * 0.5));
    }
    const tube = MeshBuilder.CreateTube("tube", { path: tubePath, radius: 0.1, tessellation: 16 }, scene);
    tube.position = new Vector3(-5, -2.5, 0);
    tube.material = col(0.5, 0.9, 0.5);

    const starShape: Vector3[] = [];
    for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 0.25 : 0.12;
        const a = (i / 10) * Math.PI * 2;
        starShape.push(new Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
    }
    starShape.push(starShape[0]!.clone());
    const extrudePath: Vector3[] = [];
    for (let i = 0; i < 20; i++) {
        const t = i / 19;
        extrudePath.push(new Vector3((t - 0.5) * 2, Math.sin(t * Math.PI) * 0.4, 0));
    }
    const star = MeshBuilder.ExtrudeShape("star", { shape: starShape, path: extrudePath, scale: 1, rotation: 0 }, scene);
    star.position = new Vector3(0, -2.5, 0);
    star.material = col(0.85, 0.5, 0.2);

    const squareShape = [
        new Vector3(-0.2, -0.2, 0),
        new Vector3(0.2, -0.2, 0),
        new Vector3(0.2, 0.2, 0),
        new Vector3(-0.2, 0.2, 0),
        new Vector3(-0.2, -0.2, 0),
    ];
    const straight: Vector3[] = [];
    for (let i = 0; i < 6; i++) straight.push(new Vector3((i / 5) * 1.5 - 0.75, 0, 0));
    const bar = MeshBuilder.ExtrudeShape("bar", { shape: squareShape, path: straight, scale: 1, rotation: 0 }, scene);
    bar.position = new Vector3(5, -2.5, 0);
    bar.material = col(0.4, 0.4, 0.9);

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) eng._drawCalls.fetchNewFrame();
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
})().catch(console.error);
