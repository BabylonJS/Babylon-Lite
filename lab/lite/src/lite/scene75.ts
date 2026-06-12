import {
    addTaskAtStart,
    addToScene,
    createDefaultCamera,
    createEffectRenderTask,
    createEffectWrapper,
    createEngine,
    createRenderTargetTexture,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    registerScene,
    setEffectUniforms,
    startEngine,
} from "babylon-lite";

const FRAGMENT_WGSL = `@group(0) @binding(0) var<uniform> params:vec4<f32>;
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{let toto=params.x/params.x;if(toto==1.0){return vec4<f32>(0.0,1.0,0.0,1.0);}if(toto>=0.999999&&toto<1.0){return vec4<f32>(0.0,0.0,1.0,1.0);}return vec4<f32>(1.0,0.0,0.0,1.0);}`;

const SCENE_CLEAR_COLOR = { r: 51 / 255, g: 51 / 255, b: 76 / 255, a: 1 };

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = SCENE_CLEAR_COLOR;

    const { rt, texture } = createRenderTargetTexture(engine, {
        lbl: "scene75-effect-rtt",
        format: "rgba8unorm",
        samples: 1,
        size: { width: 512, height: 512 },
    });

    const effect = createEffectWrapper(engine, {
        name: "scene75-effect-rtt-sphere",
        fragmentWGSL: FRAGMENT_WGSL,
        bindings: [{ name: "params", binding: 0, kind: "uniform", uniformByteLength: 16 }],
    });
    setEffectUniforms(effect, new Float32Array([15, 0, 0, 0]));

    addTaskAtStart(
        scene,
        createEffectRenderTask(
            {
                name: "scene75-effect-rtt",
                effect,
                target: rt,
                clear: true,
                clearColor: { r: 0, g: 0, b: 0, a: 1 },
            },
            engine,
            scene
        )
    );

    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    const material = createStandardMaterial();
    material.disableLighting = true;
    material.diffuseTexture = texture;
    material.emissiveColor = [1, 1, 1];
    sphere.material = material;
    addToScene(scene, sphere);

    createDefaultCamera(scene);

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
