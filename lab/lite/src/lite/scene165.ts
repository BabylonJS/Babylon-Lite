// Scene 165: Custom ShaderMaterial rendered with thin instances + per-instance color.
// 8×8×8 grid of unit cubes, deterministic translation + RGBA color ramp, fixed camera.
// Validates the ShaderMaterial thin-instance attribute injection (world0..3, instanceColor)
// and the repaired GPU-culling path (?culling).

import { addToScene, createArcRotateCamera, createBox, createEngine, createSceneContext, createShaderMaterial, enableThinInstanceGpuCulling, registerScene, setThinInstanceColors, setThinInstances, startEngine } from "babylon-lite";

const vertexSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) vColor:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;let iw=mat4x4<f32>(input.world0,input.world1,input.world2,input.world3);out.position=shaderSystem.viewProjection*(shaderSystem.world*iw)*vec4<f32>(input.position,1.0);out.vColor=input.instanceColor;return out;}`;
const fragmentSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) vColor:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return input.vColor;}`;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(-Math.PI / 5, Math.PI / 3, 40, { x: 0, y: 0, z: 0 });

    const material = createShaderMaterial({
        name: "scene165Shader",
        vertexSource,
        fragmentSource,
        attributes: ["position"],
        uniforms: ["viewProjection", "world"],
    });

    const box = createBox(engine);
    box.material = material;

    const numPerSide = 8;
    const size = 14;
    const ofst = size / (numPerSide - 1);
    const instanceCount = numPerSide * numPerSide * numPerSide;

    const matricesData = new Float32Array(16 * instanceCount);
    const colorData = new Float32Array(4 * instanceCount);

    const m = new Float32Array(16);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;

    let col = 0;
    let index = 0;
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
    if (new URLSearchParams(location.search).has("culling")) {
        enableThinInstanceGpuCulling(box);
        canvas.dataset.gpuCulling = "thin-instances";
    }
    addToScene(scene, box);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
