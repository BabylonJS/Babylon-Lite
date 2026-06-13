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
import type { Scene } from "../scene/scene.js";

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
    }

    public dispose(): void {
        // Lite owns container GPU resources through the scene; explicit container
        // disposal is a no-op until removed from the scene.
    }
}

interface ImportResult {
    meshes: LoadedMesh[];
    particleSystems: unknown[];
    skeletons: unknown[];
    animationGroups: AnimationGroup[];
    transformNodes: unknown[];
    lights: unknown[];
    /** The underlying Lite asset container (compat extension). */
    container: AssetContainer;
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
    const lite = url.endsWith(".babylon") ? await loadBabylon(engine, url) : await loadGltf(engine, url);
    return new AssetContainer(lite);
}

/** Babylon.js `SceneLoader` — async glTF/.babylon loading into a compat scene. */
export const SceneLoader = {
    /** Import meshes (and the rest of the asset) into the scene. */
    async ImportMeshAsync(_meshNames: unknown, rootUrl: string, sceneFilename: string, scene: Scene): Promise<ImportResult> {
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
    const lite = source.endsWith(".babylon") ? await loadBabylon(engine, source) : await loadGltf(engine, source);
    return new AssetContainer(lite);
}
