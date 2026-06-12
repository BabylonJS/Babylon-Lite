import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    createShaderMaterial,
    createSphere,
    registerScene,
    setShaderUniform,
    startEngine,
} from "babylon-lite";

const vertexSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}`;
const fragmentSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return vec4<f32>(shaderUniforms.tint*shaderUniforms.intensity,1.0);}`;

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
        name: "scene161Shader",
        vertexSource,
        fragmentSource,
        attributes: ["position"],
        uniforms: ["worldViewProjection", { name: "tint", type: "vec3<f32>", defaultValue: [1, 1, 1] }, { name: "intensity", type: "f32", defaultValue: 1 }],
    });
    setShaderUniform(material, "tint", [1.0, 0.35, 0.1]);
    setShaderUniform(material, "intensity", 0.85);

    const sphere = createSphere(engine, { segments: 32, diameter: 2.0 });
    sphere.material = material;
    addToScene(scene, sphere);

    await registerScene(scene);
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
