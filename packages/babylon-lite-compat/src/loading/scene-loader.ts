/**
 * Babylon.js-compatible `SceneLoader` and `AssetContainer` over Babylon Lite's
 * `loadGltf` / `loadBabylon`.
 *
 * Coverage note: the Lite asset container exposes a root-node hierarchy plus
 * animation groups rather than the flat `meshes` array Babylon.js returns. This
 * compat layer surfaces the underlying container (`_lite`) and the animation
 * groups, and registers everything through `addToScene`. A fully BJS-shaped flat
 * mesh list is not reconstructed in this initial pass.
 */

import { addToScene, loadGltf, loadBabylon } from "babylon-lite";
import type { AssetContainer as LiteAssetContainer, AnimationGroup } from "babylon-lite";

import { unsupported } from "../error.js";
import { collectLoadedMeshes, type LoadedMesh } from "./loaded-mesh.js";
import { GaussianSplattingMesh } from "../meshes/gaussian-splatting.js";
import type { Scene } from "../scene/scene.js";

/** Path portion of a URL, without any query string (`?…`) or hash fragment (`#…`). */
function urlPath(url: string): string {
    return url.split(/[?#]/)[0]!;
}

/** Splat asset extensions Babylon Lite can parse (`loadSplat` / `loadSOG` / `loadSPZ`). */
function isSplatUrl(url: string): boolean {
    const u = urlPath(url).toLowerCase();
    return u.endsWith(".ply") || u.endsWith(".splat") || u.endsWith(".sog") || u.endsWith(".spz");
}

/** True when a URL points at a `.babylon` file, ignoring any query string or hash. */
function isBabylonUrl(url: string): boolean {
    return urlPath(url).toLowerCase().endsWith(".babylon");
}

/** Last path segment of a URL, used to name a loaded Gaussian-Splatting mesh. */
function baseName(url: string): string {
    const path = urlPath(url);
    return path.slice(path.lastIndexOf("/") + 1) || "splat";
}

export class AssetContainer {
    /** @internal Underlying Babylon Lite asset container. */
    public readonly _lite: LiteAssetContainer;

    public constructor(lite: LiteAssetContainer) {
        this._lite = lite;
    }

    public get animationGroups(): AnimationGroup[] {
        return this._lite.animationGroups ?? [];
    }

    /** Flat list of renderable meshes (Babylon.js-shaped handles over the loaded node tree). */
    public get meshes(): LoadedMesh[] {
        return collectLoadedMeshes(this._lite);
    }

    /** Add every entity, animation group, camera, and clear colour to the scene. */
    public addAllToScene(scene: Scene): void {
        addToScene(scene._lite, this._lite);
        scene._surfaceLoadedCamera();
    }

    public dispose(): void {
        // Lite owns container GPU resources through the scene; explicit container
        // disposal is a no-op until removed from the scene.
    }
}

interface ImportResult {
    meshes: Array<LoadedMesh | GaussianSplattingMesh>;
    particleSystems: unknown[];
    skeletons: unknown[];
    animationGroups: AnimationGroup[];
    transformNodes: unknown[];
    lights: unknown[];
    /** The underlying Lite asset container (compat extension; absent for splat assets). */
    container?: AssetContainer;
}

/** @internal Load a splat URL into a `GaussianSplattingMesh` (shared by every loader entry point). */
async function loadSplatResult(url: string, scene: Scene): Promise<ImportResult> {
    const gs = new GaussianSplattingMesh(baseName(url), null, scene);
    await gs.loadFileAsync(url);
    return { meshes: [gs], particleSystems: [], skeletons: [], animationGroups: [], transformNodes: [], lights: [] };
}

function joinUrl(rootUrl: string, fileName: string): string {
    if (!fileName) {
        return rootUrl;
    }
    if (/^(https?:)?\/\//.test(fileName) || fileName.startsWith("/")) {
        return fileName;
    }
    return rootUrl.endsWith("/") || rootUrl === "" ? rootUrl + fileName : rootUrl + "/" + fileName;
}

async function load(rootUrl: string, fileName: string, scene: Scene): Promise<AssetContainer> {
    const url = joinUrl(rootUrl, fileName);
    const engine = scene.getEngine()._lite;
    // Detect the format from the path (ignoring query/hash), but hand the full URL
    // to the loader so any query string is preserved.
    const lite = isBabylonUrl(url) ? await loadBabylon(engine, url) : await loadGltf(engine, url);
    return new AssetContainer(lite);
}

/** Babylon.js `SceneLoader` — async glTF/.babylon loading into a compat scene. */
export const SceneLoader = {
    /** Import meshes (and the rest of the asset) into the scene. */
    async ImportMeshAsync(_meshNames: unknown, rootUrl: string, sceneFilename: string, scene: Scene): Promise<ImportResult> {
        const url = joinUrl(rootUrl, sceneFilename);
        if (isSplatUrl(url)) {
            return loadSplatResult(url, scene);
        }
        const container = await load(rootUrl, sceneFilename, scene);
        container.addAllToScene(scene);
        return {
            meshes: container.meshes,
            particleSystems: [],
            skeletons: [],
            animationGroups: container.animationGroups,
            transformNodes: [],
            lights: [],
            container,
        };
    },

    /** Append an asset's contents to the scene. */
    async AppendAsync(rootUrl: string, sceneFilename: string, scene: Scene): Promise<Scene> {
        const url = joinUrl(rootUrl, sceneFilename);
        if (isSplatUrl(url)) {
            await loadSplatResult(url, scene);
            return scene;
        }
        const container = await load(rootUrl, sceneFilename, scene);
        container.addAllToScene(scene);
        return scene;
    },

    /** Load an asset into a container without adding it to the scene. */
    async LoadAssetContainerAsync(rootUrl: string, sceneFilename: string, scene: Scene): Promise<AssetContainer> {
        return load(rootUrl, sceneFilename, scene);
    },

    /** Plugin registration — out of scope (side-effectful global registry). */
    RegisterPlugin(): never {
        return unsupported(
            "SceneLoader.RegisterPlugin",
            "Loader plugin registration is out of scope for the compat layer (it relies on a side-effectful global registry). Import the loader you need directly."
        );
    },
};

// ── Function-style loaders (Babylon.js 7+ `@babylonjs/core/Loading/sceneLoader`) ──

/** Babylon.js `ImportMeshAsync(source, scene, options?)` — imports an asset into the scene. */
export async function ImportMeshAsync(source: string, scene: Scene, _options?: unknown): Promise<ImportResult> {
    if (isSplatUrl(source)) {
        return loadSplatResult(source, scene);
    }
    const container = await loadFromSource(source, scene);
    container.addAllToScene(scene);
    return {
        meshes: container.meshes,
        particleSystems: [],
        skeletons: [],
        animationGroups: container.animationGroups,
        transformNodes: [],
        lights: [],
        container,
    };
}

/** Babylon.js `AppendSceneAsync(source, scene, options?)` — appends an asset's contents to the scene. */
export async function AppendSceneAsync(source: string, scene: Scene, _options?: unknown): Promise<Scene> {
    if (isSplatUrl(source)) {
        await loadSplatResult(source, scene);
        return scene;
    }
    const container = await loadFromSource(source, scene);
    container.addAllToScene(scene);
    return scene;
}

/** Babylon.js `LoadAssetContainerAsync(source, scene, options?)` — loads into a container without adding. */
export async function LoadAssetContainerAsync(source: string, scene: Scene, _options?: unknown): Promise<AssetContainer> {
    return loadFromSource(source, scene);
}

/** @internal Load a glTF/.babylon asset from a single source URL (function-loader form). */
async function loadFromSource(source: string, scene: Scene): Promise<AssetContainer> {
    const engine = scene.getEngine()._lite;
    // Detect the format from the path (ignoring query/hash), but pass the full URL
    // to the loader so any query string is preserved.
    const lite = isBabylonUrl(source) ? await loadBabylon(engine, source) : await loadGltf(engine, source);
    return new AssetContainer(lite);
}
