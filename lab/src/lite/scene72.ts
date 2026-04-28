// Scene 72: Final D8AK3Z PBR-NME parity. Loads local EPY8BV#6 data (the full
// PBR-MR + Reflection + ClearCoat + Sheen + Anisotropy + SubSurface NME
// graph) and renders the 4-light scene from playground D8AK3Z#160.
//
// This is the full visual parity coverage scene for the PBR-MR NME stack.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createSphere,
    createGround,
    createHemisphericLight,
    createPointLight,
    createSpotLight,
    createDirectionalLight,
    createPcfDirectionalShadowGenerator,
    attachControl,
    registerScene,
    parseNodeMaterialFromSnippet,
    loadEnvironment,
    createSolidTexture2D,
    loadTexture2D,
} from "babylon-lite";
import type { Mesh, Texture2D } from "babylon-lite";
import { getScene72Nme } from "../shared/scene72-nme.js";

function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

async function loadSnippetTextures(engine: Parameters<typeof loadTexture2D>[0], json: unknown): Promise<Record<string, Texture2D>> {
    const blocks = (json as { blocks?: Array<Record<string, unknown>> }).blocks ?? [];
    const out: Record<string, Texture2D> = {};
    for (const b of blocks) {
        if (b.customType !== "BABYLON.TextureBlock" && b.customType !== "BABYLON.ImageSourceBlock") continue;
        const tex = b.texture as
            | { url?: string; name?: string; gammaSpace?: boolean; invertY?: boolean; uOffset?: number; vOffset?: number; uScale?: number; vScale?: number }
            | undefined;
        // The original snippet stored embedded data URIs; the checked-in graph
        // points those textures at local assets to keep JS bundles small.
        const url = tex?.url && tex.url.length > 0 ? tex.url : tex?.name && tex.name.startsWith("data:") ? tex.name : undefined;
        if (!url) continue;
        const key = sanitize((b.name as string | undefined) || `tex${b.id}`);
        // Honor texture.invertY from the snippet JSON (defaults to true in BJS, but
        // many embedded snippet textures have it explicitly set false — failing to
        // honor this flips bump/albedo/etc. upside down vs BJS reference).
        const invertY = tex?.invertY ?? true;
        try {
            out[key] = await loadTexture2D(engine, url, { invertY });
        } catch (e) {
            console.warn("scene72: failed to load", key, e);
        }
    }
    return out;
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.6, g: 0.8, b: 1, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 7, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera, canvas, scene);

    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    const hemi = createHemisphericLight([0, 1, 0], 1);
    addToScene(scene, hemi);
    const point = createPointLight([0, 5, -2], 1);
    addToScene(scene, point);
    const spot = createSpotLight([-0.5, 0, -2], [0, 0, 1], Math.PI / 2, 1, 1);
    addToScene(scene, spot);
    const dir = createDirectionalLight([1, -1, 1], 10);
    addToScene(scene, dir);

    const sphere = createSphere(engine, { segments: 32, diameter: 2 });
    const ground = createGround(engine, { width: 6, height: 6 });
    ground.position.set(0, -1, 0);
    ground.receiveShadows = true;
    (ground as Mesh & { layerMask?: number }).layerMask = 1;

    const sg = createPcfDirectionalShadowGenerator(engine, dir, [sphere], { mapSize: 1024, orthoMinZ: -2, orthoMaxZ: 15 });
    dir.shadowGenerator = sg;

    const json = await getScene72Nme();

    // Load all local NME texture assets (Albedo, MetallicRoughness,
    // AO, Opacity, Bump, Sheen, Anisotropy, ClearCoat, ClearCoat bump, ClearCoat tint,
    // SubSurface thickness). Anything we fail to load falls back to a 1×1 solid.
    const loaded = await loadSnippetTextures(engine, json);
    const white = createSolidTexture2D(engine, 1, 1, 1, 1);
    const flatNormal = createSolidTexture2D(engine, 0.5, 0.5, 1, 1);
    const black = createSolidTexture2D(engine, 0, 0, 0, 1);
    const fallback: Record<string, typeof white> = {
        Albedo_texture: white,
        MetallicRoughness_texture: white,
        AO_texture: white,
        Opacity_texture: white,
        Bump_texture: flatNormal,
        Sheen_texture: white,
        Anisotropy_texture: black,
        ClearCoat_texture: white,
        ClearCoat_bump_texture: flatNormal,
        ClearCoat_tint_texture: white,
        SubSurface_thickness_texture: white,
    };
    const textures = { ...fallback, ...loaded };
    const material = await parseNodeMaterialFromSnippet(engine, "", { json, textures, shadowGenerators: [sg] });
    (sphere as { material?: unknown }).material = material;
    (ground as { material?: unknown }).material = material;

    addToScene(scene, sphere);
    addToScene(scene, ground);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
