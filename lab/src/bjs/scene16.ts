import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Scene } from "@babylonjs/core/scene";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);

    const camera = new ArcRotateCamera("Camera", -Math.PI / 5, Math.PI / 3, 200, Vector3.Zero(), scene);
    camera.attachControl(canvas, true);

    const box = MeshBuilder.CreateBox("root", { size: 1 }, scene);

    const numPerSide = 40,
        size = 100,
        ofst = size / (numPerSide - 1);
    const m = Matrix.Identity();
    let col = 0,
        index = 0;
    const instanceCount = numPerSide * numPerSide * numPerSide;

    const matricesData = new Float32Array(16 * instanceCount);
    const colorData = new Float32Array(4 * instanceCount);

    for (let x = 0; x < numPerSide; x++) {
        m.m[12] = -size / 2 + ofst * x;
        for (let y = 0; y < numPerSide; y++) {
            m.m[13] = -size / 2 + ofst * y;
            for (let z = 0; z < numPerSide; z++) {
                m.m[14] = -size / 2 + ofst * z;
                m.copyToArray(matricesData, index * 16);

                const coli = Math.floor(col);
                colorData[index * 4 + 0] = ((coli & 0xff0000) >> 16) / 255;
                colorData[index * 4 + 1] = ((coli & 0x00ff00) >> 8) / 255;
                colorData[index * 4 + 2] = ((coli & 0x0000ff) >> 0) / 255;
                colorData[index * 4 + 3] = 1.0;

                index++;
                col += 0xffffff / instanceCount;
            }
        }
    }

    box.thinInstanceSetBuffer("matrix", matricesData, 16);
    box.thinInstanceSetBuffer("color", colorData, 4);

    box.material = new StandardMaterial("material", scene);
    (box.material as StandardMaterial).disableLighting = true;
    (box.material as StandardMaterial).emissiveColor = Color3.White();

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
