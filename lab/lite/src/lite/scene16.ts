// Scene 16: Thin Instances — 64K colored cubes
// Matches BJS playground #V1JE4Z#1

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createBox, createStandardMaterial, setThinInstances, setThinInstanceColors, attachControl, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(-Math.PI / 5, Math.PI / 3, 200, { x: 0, y: 0, z: 0 });
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    const box = createBox(engine);
    const mat = createStandardMaterial();
    mat.disableLighting = true;
    mat.emissiveColor = [1, 1, 1];
    box.material = mat;

    const numPerSide = 40;
    const size = 100;
    const ofst = size / (numPerSide - 1);
    const instanceCount = numPerSide * numPerSide * numPerSide;

    const matricesData = new Float32Array(16 * instanceCount);
    const colorData = new Float32Array(4 * instanceCount);

    let col = 0;
    let index = 0;
    // Identity matrix template
    const m = new Float32Array(16);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;

    for (let x = 0; x < numPerSide; x++) {
        m[12] = -size / 2 + ofst * x;
        for (let y = 0; y < numPerSide; y++) {
            m[13] = -size / 2 + ofst * y;
            for (let z = 0; z < numPerSide; z++) {
                m[14] = -size / 2 + ofst * z;
                matricesData.set(m, index * 16);

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

    setThinInstances(box, matricesData, instanceCount);
    setThinInstanceColors(box, colorData);
    addToScene(scene, box);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
