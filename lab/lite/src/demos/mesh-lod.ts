// Experimental MeshLoD demo — streaming clustered level-of-detail
//
// Showcase-only page. Streams the statue as `.mlod` clustered-LOD primitives
// through Babylon Lite's public, opt-in MeshLoD
// path: `loadMeshLoD` → `createMeshLoDInstance` → `addMeshLoDToScene`. Selection,
// streaming, caching, and material-owned indirect rendering are all the
// production runtime — the demo adds no loader, selector, cache, or renderer of
// its own.
//
// The source GLB is loaded ONLY to reuse its existing PBR materials
// (base-colour textures) and node transforms; its ordinary meshes are never added
// to the scene, so nothing but the MeshLoD instances renders. This is a demo
// asset-preparation compromise, not a MeshLoD runtime dependency — application
// code can supply any supported `PbrMaterialProps` + transform without loading
// glTF geometry.
//
// Model attribution (CC BY 4.0):
//   "Harvard-Yenching Institute statue" by Alexandre Tokovinine
//   (https://sketchfab.com/tokovinin3d), CC BY 4.0.

import {
    addMeshLoDToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createMeshLoDInstance,
    createSceneContext,
    getContainerMeshes,
    loadEnvironment,
    loadGltf,
    loadMeshLoD,
    registerScene,
    setCameraLimits,
    setRenderTaskGpuTimingEnabled,
    startEngine,
    type MeshLoDAsset,
    type MeshLoDDebugView,
    type MeshLoDInstance,
    type PbrMaterialProps,
    type AssetContainer,
    type SceneNode,
} from "babylon-lite";
import { configureDemoDecoderBases, demoAssetUrl } from "./demo-asset-url.js";
import { installFetchProgress } from "./loading-progress.js";
import { createMeshLoDNetworkSimulator } from "./mesh-lod-network-simulator.js";
import { sampleMeshLoDCameraPath } from "./mesh-lod-camera-path.js";
import { installMeshLoDControls } from "./mesh-lod-controls.js";
import { installMeshLoDDiagnostics } from "./mesh-lod-diagnostics.js";

interface MeshLoDModel {
    id: string;
    sourceGlb: string;
    mlodFiles: readonly string[];
    estimatedBytes: number;
}

function primitiveFiles(base: string, count: number): string[] {
    return Array.from({ length: count }, (_, index) => `${base}.mesh${String(index).padStart(3, "0")}.prim000.mlod`);
}

const MODEL: MeshLoDModel = {
    id: "harvard",
    sourceGlb: "https://assets.babylonjs.com/meshes/harvard-yenching/harvard-yenching_institute_statue.glb",
    mlodFiles: primitiveFiles("harvard-yenching_institute_statue", 3),
    estimatedBytes: 20_000_000,
};
const ENV_URL = "https://assets.babylonjs.com/core/environments/environmentSpecular.env";
const GROUND_TEXTURE_URL = "https://assets.babylonjs.com/core/environments/backgroundGround.png";
const SKYBOX_URL = "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds";

const DEG = Math.PI / 180;

/** Aggregate world-space bounds of the placed statue instances. */
export interface StatueBounds {
    center: { x: number; y: number; z: number };
    radius: number;
}

/**
 * Resolve the base URL for the `.mlod` (and source GLB) assets.
 *
 * In the lab dev server the demo bundle is served from `/lite/bundle/demos/`,
 * while the committed assets under `lab/public/mesh-lod/` are served — WITH HTTP
 * Range support (`206 Partial Content`) — from `/mesh-lod/`. MeshLoD streams via
 * range requests, so dev must use that Range-capable public path. In the
 * standalone deployed demo the assets are copied next to the bundle, so they
 * resolve relative to this module.
 */
function meshLodBase(moduleUrl: string): string {
    if (moduleUrl.includes("/lite/bundle/demos/")) {
        return new URL("/mesh-lod/", moduleUrl).href;
    }
    return new URL("./mesh-lod/", moduleUrl).href;
}

/** Connect parent links without registering the source meshes for rendering. */
function connectContainerHierarchy(container: AssetContainer): void {
    const connect = (node: SceneNode): void => {
        for (const child of node.children) {
            child.parent = node;
            connect(child);
        }
    };
    for (const entity of container.entities) {
        if (!("lightType" in entity)) {
            connect(entity);
        }
    }
}

function determinantSign(node: SceneNode): "negative" | "positive" | "zero" {
    const m = node.worldMatrix;
    const determinant =
        m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) +
        m[1]! * (m[6]! * m[8]! - m[4]! * m[10]!) +
        m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);
    return determinant < 0 ? "negative" : determinant > 0 ? "positive" : "zero";
}

/** Transform the 8 corners of every asset's local bounds by its instance world
 *  matrix and union them into an aggregate world-space bounding sphere. */
function computeStatueBounds(instances: readonly MeshLoDInstance[], assets: readonly MeshLoDAsset[]): StatueBounds {
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (let i = 0; i < instances.length; i++) {
        const m = instances[i]!.worldMatrix;
        const b = assets[i]!.metadata;
        const lo = b.boundsMin;
        const hi = b.boundsMax;
        for (let c = 0; c < 8; c++) {
            const x = c & 1 ? hi[0] : lo[0];
            const y = c & 2 ? hi[1] : lo[1];
            const z = c & 4 ? hi[2] : lo[2];
            const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
            const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
            const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
            minX = Math.min(minX, wx);
            minY = Math.min(minY, wy);
            minZ = Math.min(minZ, wz);
            maxX = Math.max(maxX, wx);
            maxY = Math.max(maxY, wy);
            maxZ = Math.max(maxZ, wz);
        }
    }
    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
    const radius = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    return { center, radius: radius > 0 && Number.isFinite(radius) ? radius : 1 };
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const requestedModel = new URLSearchParams(location.search).get("model");
    if (requestedModel && requestedModel !== MODEL.id) {
        throw new Error(`MeshLoD model "${requestedModel}" is not bundled with this demo`);
    }
    const model = MODEL;

    // Capture the pristine fetch BEFORE installing the loading-progress wrapper,
    // then route MeshLoD's range traffic through the network simulator (which
    // wraps the pristine fetch). This keeps MeshLoD traffic independent of the
    // progress wrapper — which tracks the dominant downloads, the source GLB and
    // the environment — and throttles ONLY `.mlod` requests. Defaults mirror
    // architecture §15.3: 8 MiB/s, 100 ms latency, so streaming is observable.
    const rawFetch: typeof fetch = globalThis.fetch.bind(globalThis);
    const networkSim = createMeshLoDNetworkSimulator(rawFetch, { bandwidthBytesPerSecond: 8 * 1024 * 1024, latencyMs: 100 });
    const progress = installFetchProgress(canvas, { estimatedBytes: model.estimatedBytes });

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    await configureDemoDecoderBases(import.meta.url);

    const base = meshLodBase(import.meta.url);

    // Load the source GLB (materials + transforms), the environment (IBL only),
    // and the streamed LOD primitives together. MeshLoD fetches through the
    // network simulator so bandwidth/latency controls affect only `.mlod` traffic.
    const [container, assets] = await Promise.all([
        loadGltf(engine, model.sourceGlb),
        Promise.all(model.mlodFiles.map((file) => loadMeshLoD(engine, `${base}${file}`, { request: { fetch: networkSim.fetch } }))),
        loadEnvironment(scene, ENV_URL, {
            groundTextureUrl: GROUND_TEXTURE_URL,
            skyboxUrl: SKYBOX_URL,
            skyboxSize: 1000,
            brdfUrl: demoAssetUrl("./brdf-lut.png", import.meta.url),
        }),
    ]);
    connectContainerHierarchy(container);

    // Reuse the GLB's PBR materials + node transforms. The ordinary source meshes
    // are NOT added to the scene, so only the MeshLoD instances render.
    const meshes = getContainerMeshes(container);
    const instances: MeshLoDInstance[] = [];
    for (let i = 0; i < assets.length; i++) {
        const asset = assets[i]!;
        const source = meshes[asset.metadata.meshIndex] ?? meshes[i];
        if (!source) {
            throw new Error(`Missing source mesh for MeshLoD primitive ${i}`);
        }
        const instance = createMeshLoDInstance(asset, source.material as unknown as PbrMaterialProps, { name: `${model.id}-prim-${i}` });
        // Borrow the source mesh's exact world transform (its glTF node chain);
        // the source mesh itself is never registered, so it never renders.
        instance.parent = source;
        addMeshLoDToScene(scene, instance);
        instances.push(instance);
    }

    // Lift the exposure above loadEnvironment's default (0.8) so the marble reads
    // brightly against the dark background.
    scene.imageProcessing.exposure = 1.15;

    // Frame the camera from the aggregate world bounds.
    const bounds = computeStatueBounds(instances, assets);
    const cam = createArcRotateCamera(-0.8 * Math.PI, 58 * DEG, bounds.radius * 1.85, bounds.center);
    cam.fov = 0.8;
    cam.nearPlane = Math.max(bounds.radius * 0.01, 0.01);
    cam.farPlane = bounds.radius * 100;
    scene.camera = cam;
    attachControl(cam, canvas, scene);
    setCameraLimits(cam, { lowerRadiusLimit: bounds.radius * 0.35 }, scene);

    // Opt into per-render-task GPU timing so the diagnostics panel can report a
    // real duration (or an explicit "unsupported"/"pending" status — never a fake 0).
    await setRenderTaskGpuTimingEnabled(engine, true);

    // Live diagnostics + debug-view legend.
    const diagnosticsContainer = document.getElementById("meshLodDiagnostics");
    const legendContainer = document.getElementById("meshLodLegend");
    const diagnostics =
        diagnosticsContainer && legendContainer ? installMeshLoDDiagnostics({ container: diagnosticsContainer, legendContainer, engine, assets }) : null;

    const controlsContainer = document.getElementById("meshLodControls");
    if (controlsContainer) {
        installMeshLoDControls({
            container: controlsContainer,
            assets,
            networkSim,
            onDebugViewChange: (view: MeshLoDDebugView) => {
                diagnostics?.setLegend(view);
            },
        });
    }

    // `?pathTime=<seconds>` freezes the camera at a deterministic path pose for
    // repeatable capture/verification (mirrors the scenes' `?seekTime=`).
    const pathTimeParam = new URLSearchParams(location.search).get("pathTime");
    if (pathTimeParam !== null) {
        const pathTime = Number(pathTimeParam);
        if (!Number.isFinite(pathTime)) {
            throw new Error(`Invalid MeshLoD pathTime "${pathTimeParam}"`);
        }
        const pose = sampleMeshLoDCameraPath(bounds, pathTime);
        cam.alpha = pose.alpha;
        cam.beta = pose.beta;
        cam.radius = pose.radius;
        canvas.dataset.cameraPathFrozen = "true";
    }

    await registerScene(scene);
    progress.done();
    await startEngine(engine);

    canvas.dataset.sourceTriangles = String(assets.reduce((sum, a) => sum + a.metadata.sourceTriangleCount, 0));
    canvas.dataset.model = model.id;
    canvas.dataset.sourceGlb = model.sourceGlb;
    canvas.dataset.instanceCount = String(instances.length);
    canvas.dataset.instanceHandedness = instances.map(determinantSign).join(",");
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camBeta = String(cam.beta);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.ready = "true";
}

main().catch((err: unknown) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas");
    const message = err instanceof Error ? err.message : String(err);
    canvas?.setAttribute("data-error", message || "true");
});
