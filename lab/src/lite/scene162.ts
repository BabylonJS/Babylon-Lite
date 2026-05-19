import { addToScene, createArcRotateCamera, createEngine, createSceneContext, createShaderMaterial, createTorus, registerScene, startEngine } from "babylon-lite";

const vertexSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}`;
const fragmentSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{if(USE_BLUE){return vec4<f32>(25.0/255.0,0.28,1.00,1.0);}return vec4<f32>(1.00,25.0/255.0,25.0/255.0,1.0);}`;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 51 / 255, g: 51 / 255, b: 76 / 255, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.25, 4.2, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;

    const material = createShaderMaterial({
        name: "scene162Shader",
        vertexSource,
        fragmentSource,
        attributes: ["position"],
        uniforms: ["worldViewProjection"],
        defines: { USE_BLUE: true },
    });
    const torus = createTorus(engine, { diameter: 2.0, thickness: 0.45, tessellation: 64 });
    torus.material = material;
    addToScene(scene, torus);

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
