// Scene 217: Opt-in Material Plugins — BlackAndWhite grayscale.
//
// Demonstrates the public `MaterialPlugin` API: a custom WGSL snippet is layered
// on top of the built-in PBR and Standard lighting pipelines via the
// `material.plugins = [plugin]` opt-in. The BlackAndWhite plugin injects a
// grayscale conversion at the BJS `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` point
// (Lite slot `BC`, after tonemap + gamma), turning both meshes grayscale while
// the full lighting / specular response is preserved.
//
// The plugin's WGSL lives here in the scene module (not the engine). Material
// plugins are an explicit opt-in: the scene calls `enableMaterialPlugins(scene)`
// after meshes are added and before `registerScene`, which is the only thing
// that pulls the plugin bridge into the graph. A PBR sphere (left) and a
// Standard box (right) share the same stateless plugin object.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createSphere,
    createBox,
    createHemisphericLight,
    createDirectionalLight,
    createPbrMaterial,
    createStandardMaterial,
    createSolidTexture2D,
    registerScene,
    attachControl,
    enableMaterialPlugins,
} from "babylon-lite";
import type { ArcRotateCamera, MaterialPlugin } from "babylon-lite";

// ── BlackAndWhite plugin (the user's WGSL ships here, not in the engine) ──
const blackAndWhite: MaterialPlugin = {
    name: "BlackAndWhite",
    getCustomCode(shaderType) {
        if (shaderType !== "fragment") {
            return null;
        }
        // `color` is the working color at BC for both PBR (vec3) and Standard
        // (vec4); per-component writes work for both.
        return {
            CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
let bwLuma = dot(color.rgb, vec3<f32>(0.3, 0.59, 0.11));
color.r = bwLuma;
color.g = bwLuma;
color.b = bwLuma;`,
        };
    },
};

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.35, g: 0.45, b: 0.6, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 7, { x: 0, y: 0, z: 0 });
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    const hemi = createHemisphericLight([0, 1, 0], 0.7);
    addToScene(scene, hemi);
    const dir = createDirectionalLight([-0.5, -1, -0.6], 0.9);
    addToScene(scene, dir);

    // PBR sphere (left) — warm red dielectric, grayscaled by the plugin.
    const pbrMat = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.85, 0.2, 0.15, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.4, 0.0, 1),
        usePhysicalLightFalloff: false,
    });
    pbrMat.plugins = [blackAndWhite];

    const sphere = createSphere(engine, { diameter: 2.2, segments: 48 });
    sphere.position.set(-1.5, 0, 0);
    sphere.material = pbrMat;
    addToScene(scene, sphere);

    // Standard box (right) — blue diffuse, grayscaled by the same plugin.
    const stdMat = createStandardMaterial();
    stdMat.diffuseColor = [0.15, 0.3, 0.85];
    stdMat.specularColor = [0.4, 0.4, 0.4];
    stdMat.plugins = [blackAndWhite];

    const box = createBox(engine, 2);
    box.position.set(1.5, 0, 0);
    box.material = stdMat;
    addToScene(scene, box);

    enableMaterialPlugins(scene);
    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
