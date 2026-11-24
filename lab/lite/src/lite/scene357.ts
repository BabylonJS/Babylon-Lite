// Scene 357 — selective glow over ShaderMaterial and PBR surfaces (GlowPostProcessTask).
// A ShaderMaterial has no emissive source: the bright orange cube renders in the neutral color and occludes the
// Standard LED behind it, while the violet bar glows only because the color selector picks it through metadata.
// PBR covers an emissive texture under a white factor and a bright unlit surface without emission.

import {
    addTask,
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGlowPostProcessTask,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    createShaderMaterial,
    createSolidTexture2D,
    createStandardMaterial,
    registerScene,
    setPbrEmissive,
    setPbrUnlit,
    startEngine,
    wgsl,
} from "babylon-lite";
import type { EngineContext, Material, Mesh, SceneContext } from "babylon-lite";
import { GLOW_SCENE, SCENE357_BAR_COLOR, SCENE357_LED_COLOR, SCENE357_OCCLUDER_COLOR, scene357LiteShader, settle } from "../shared/scene356-glow.js";

function box(engine: EngineContext, scene: SceneContext, material: Material, position: readonly [number, number, number], size: readonly [number, number, number]): Mesh {
    const mesh = createBox(engine, { width: size[0], height: size[1], depth: size[2] });
    mesh.material = material;
    mesh.position.set(...position);
    addToScene(scene, mesh);
    return mesh;
}

function shader(name: string, color: readonly number[]): Material {
    const source = scene357LiteShader(color);
    return createShaderMaterial({
        name,
        vertexSource: wgsl`${source.vertex}`,
        fragmentSource: wgsl`${source.fragment}`,
        attributes: ["position"],
        uniforms: ["worldViewProjection"],
    });
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    const [r, g, b] = GLOW_SCENE.background;
    scene.clearColor = { r, g, b, a: 1 };
    const [tx, ty, tz] = GLOW_SCENE.target;
    const camera = createArcRotateCamera(GLOW_SCENE.alpha, GLOW_SCENE.beta, GLOW_SCENE.radius, { x: tx, y: ty, z: tz });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    addToScene(scene, createHemisphericLight([...GLOW_SCENE.lightDirection], GLOW_SCENE.lightIntensity));

    const matte = createStandardMaterial();
    matte.diffuseColor = [...GLOW_SCENE.matteDiffuse];
    matte.specularColor = [...GLOW_SCENE.matteSpecular];
    box(engine, scene, matte, [0, 1.5, 0.9], [8, 3.2, 0.2]);
    box(engine, scene, matte, [0, 0, 0], [8, 0.15, 3]);

    const led = createStandardMaterial();
    led.disableLighting = true;
    led.emissiveColor = [...SCENE357_LED_COLOR];
    box(engine, scene, led, [-1.5, 1.5, 0.4], [0.1, 2.5, 0.1]);
    box(engine, scene, shader("occluder", SCENE357_OCCLUDER_COLOR), [-1.5, 0.9, -0.3], [0.9, 0.9, 0.9]);
    const bar = box(engine, scene, shader("bar", SCENE357_BAR_COLOR), [1.2, 2.2, 0.4], [2.4, 0.12, 0.1]);
    bar.metadata = { glowColor: [...SCENE357_BAR_COLOR] };

    // PBR: an emissive texture under a white factor, and a bright unlit surface without emission.
    const amber = createPbrMaterial({
        baseColorFactor: [0, 0, 0, 1],
        metallicFactor: 0,
        roughnessFactor: 1,
        emissiveTexture: createSolidTexture2D(engine, 1, 0.35, 0.025, 1),
    });
    setPbrEmissive(amber, [1, 1, 1]);
    box(engine, scene, amber, [-3, 1.5, 0.4], [0.1, 2.5, 0.1]);
    const white = createPbrMaterial({ baseColorTexture: createSolidTexture2D(engine, 1, 1, 1, 1) });
    setPbrUnlit(white);
    box(engine, scene, white, [3.2, 1, 0.1], [0.8, 0.8, 0.8]);

    const output = scene.defaultRenderTask!.config;
    addTask(
        scene,
        createGlowPostProcessTask(
            {
                name: "glow",
                targetTexture: output.rt,
                resolveTexture: output.rst,
                intensity: GLOW_SCENE.intensity,
                blurKernelSize: GLOW_SCENE.kernel,
                // The result starts with the surface's own glow color: only selected meshes are overridden.
                customEmissiveColorSelector(mesh, _material, result) {
                    const color = mesh.metadata?.glowColor as readonly number[] | undefined;
                    if (color) {
                        result.r = color[0]!;
                        result.g = color[1]!;
                        result.b = color[2]!;
                        result.a = 1;
                    }
                },
            },
            engine,
            scene
        )
    );

    await registerScene(scene);
    await startEngine(engine);
    await settle(GLOW_SCENE.settleFrames);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
