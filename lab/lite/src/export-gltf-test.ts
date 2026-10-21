/** glTF export round-trip harness for tests/lite/plumbing/export-gltf.spec.ts.
 *
 *  Exposes `window.exportGltfTest`: load an asset (or build a native scene), export it, reload the
 *  export, and export again, returning both GLBs (base64) and every warning the exports logged. */

import {
    addToScene,
    createBox,
    createDirectionalLight,
    createEngine,
    createFreeCamera,
    createPbrMaterial,
    createPointLight,
    createSceneContext,
    createSphere,
    createSpotLight,
    createStandardMaterial,
    createTexture2DFromPixels,
    createTransformNode,
    enableGltfCameras,
    exportSceneAsGlb,
    loadGltf,
} from "babylon-lite";
import type { EngineContext, SceneContext } from "babylon-lite";

export interface ExportRoundTrip {
    /** First export, base64. */
    first: string;
    /** Export of the reloaded first export, base64. */
    second: string;
    /** Export of the reloaded second export, base64. */
    third: string;
    /** Warnings logged by the first and the second export, in order. */
    warnings: string[];
    /** Mesh / light counts of the source scene and of the reloaded scene. */
    counts: { meshes: number; lights: number; reloadedMeshes: number; reloadedLights: number; camera: boolean; reloadedCamera: boolean };
}

export interface ExportGltfTest {
    roundTripAsset(url: string): Promise<ExportRoundTrip>;
    roundTripNative(): Promise<ExportRoundTrip>;
    /** Load a GLB (base64) into a fresh scene, export it once and return the export (base64) and the warnings it logged. */
    exportGlb(glbBase64: string): Promise<{ glb: string; warnings: string[] }>;
}

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
let enginePromise: Promise<EngineContext> | null = null;

function getEngine(): Promise<EngineContext> {
    enginePromise ??= createEngine(canvas);
    return enginePromise;
}

function toBase64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

async function exportCapturingWarnings(scene: SceneContext, warnings: string[]): Promise<Blob> {
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
    };
    try {
        return await exportSceneAsGlb(scene);
    } finally {
        console.warn = original;
    }
}

async function reload(engine: EngineContext, glb: Blob): Promise<SceneContext> {
    const scene = createSceneContext(engine);
    const container = await loadGltf(engine, glb);
    addToScene(scene, container);
    // Loaded cameras land in the container; make the first one the scene camera, as an app would.
    scene.camera ??= container.cameras?.[0] ?? null;
    return scene;
}

async function roundTrip(engine: EngineContext, scene: SceneContext): Promise<ExportRoundTrip> {
    const warnings: string[] = [];
    const first = await exportCapturingWarnings(scene, warnings);
    const reloaded = await reload(engine, first);
    const second = await exportCapturingWarnings(reloaded, warnings);
    const third = await exportCapturingWarnings(await reload(engine, second), warnings);
    return {
        first: toBase64(new Uint8Array(await first.arrayBuffer())),
        second: toBase64(new Uint8Array(await second.arrayBuffer())),
        third: toBase64(new Uint8Array(await third.arrayBuffer())),
        warnings,
        counts: {
            meshes: scene.meshes.length,
            lights: scene.lights.length,
            reloadedMeshes: reloaded.meshes.length,
            reloadedLights: reloaded.lights.length,
            camera: !!scene.camera,
            reloadedCamera: !!reloaded.camera,
        },
    };
}

const api: ExportGltfTest = {
    async roundTripAsset(url) {
        const engine = await getEngine();
        enableGltfCameras();
        const scene = createSceneContext(engine);
        const container = await loadGltf(engine, url);
        addToScene(scene, container);
        scene.camera ??= container.cameras?.[0] ?? null;
        return roundTrip(engine, scene);
    },
    async exportGlb(glbBase64) {
        const engine = await getEngine();
        enableGltfCameras();
        const bytes = Uint8Array.from(atob(glbBase64), (c) => c.charCodeAt(0));
        const scene = await reload(engine, new Blob([bytes], { type: "model/gltf-binary" }));
        const warnings: string[] = [];
        const exported = await exportCapturingWarnings(scene, warnings);
        return { glb: toBase64(new Uint8Array(await exported.arrayBuffer())), warnings };
    },
    async roundTripNative() {
        const engine = await getEngine();
        enableGltfCameras();
        const scene = createSceneContext(engine);

        const checker = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) {
            const on = ((i & 3) + (i >> 2)) & 1;
            checker.set(on ? [230, 60, 40, 255] : [30, 90, 200, 255], i * 4);
        }
        const pbr = createPbrMaterial({ baseColorTexture: createTexture2DFromPixels(engine, checker, 4, 4, { srgb: true }), metallicFactor: 0.2, roughnessFactor: 0.6 });
        pbr.name = "pbr";
        const box = createBox(engine, 1);
        box.name = "box";
        box.material = pbr;
        box.position.set(-1, 0.5, 0);

        const std = createStandardMaterial();
        std.name = "standard";
        std.diffuseColor = [0.9, 0.7, 0.2];
        std.diffuseTexture = createTexture2DFromPixels(engine, checker, 4, 4);
        const sphere = createSphere(engine, { diameter: 1 });
        sphere.name = "sphere";
        sphere.material = std;
        const group = createTransformNode("group", 1, 0.5, 0, 0, 0.3826834, 0, 0.9238795, 1, 2, 1);
        sphere.parent = group;
        group.children.push(sphere);

        addToScene(scene, box);
        addToScene(scene, group);
        const spot = createSpotLight([0, 4, 0], [0, -1, 0], Math.PI / 3, 1, 2);
        spot.name = "spot";
        addToScene(scene, spot);
        addToScene(scene, createPointLight([2, 2, -2], 0.5));
        addToScene(scene, createDirectionalLight([0.3, -1, 0.2], 0.8));
        scene.camera = createFreeCamera({ x: 0, y: 2, z: -6 }, { x: 0, y: 0.5, z: 0 });
        return roundTrip(engine, scene);
    },
};

(window as unknown as { exportGltfTest: ExportGltfTest }).exportGltfTest = api;
canvas.dataset.ready = "true";
