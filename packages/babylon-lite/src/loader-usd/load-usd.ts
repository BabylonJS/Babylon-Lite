import type { EngineContext } from "../engine/engine.js";
import type { LoadUsdOptions, UsdAssetContainer, UsdBinaryInput } from "./usd-types.js";
import { extractUsd } from "./usd-worker-client.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { releaseTexture } from "../resource/gpu-pool.js";

/**
 * Load a USD/USDA/USDC/USDZ asset with the shared OpenUSD WASM worker.
 * Returns a scene-independent container for `addToScene(scene, result)`.
 * Supply external layers and textures through `options.files`; URLs are not crawled.
 * @param engine - Engine that will own GPU resources.
 * @param source - Root layer URL, bytes, or Blob/File.
 * @param options - Runtime location, virtual supporting files, progress and cancellation.
 * @returns A container whose resources can be released with {@link disposeUsd}.
 */
export async function loadUsd(engine: EngineContext, source: string | UsdBinaryInput, options: LoadUsdOptions = {}): Promise<UsdAssetContainer> {
    const extracted = await extractUsd(source, options);
    const started = performance.now();
    const container: UsdAssetContainer = {
        entities: [],
        _usdMeshes: [],
        _usdTextures: [],
        diagnostics: { timings: { ...extracted.timings, materializeMs: 0 }, statistics: extracted.statistics, missingAssets: extracted.missingAssets },
    };
    try {
        options.signal?.throwIfAborted();
        options.onProgress?.({ phase: "materializing", message: "Creating Lite scene objects..." });
        const { materializeUsd } = await import("./usd-materialize.js");
        await materializeUsd(engine, extracted, container, options.signal);
        options.signal?.throwIfAborted();
        container.diagnostics.timings.materializeMs = performance.now() - started;
        return container;
    } catch (error) {
        disposeUsd(container);
        throw error;
    }
}

/** Release a USD container's resource claims once. Remove it from all scenes first.
 * Shared geometry/textures stay alive until their last owner releases them.
 * @param container - Result of {@link loadUsd}. */
export function disposeUsd(container: UsdAssetContainer): void {
    if (container._usdDisposed) {
        return;
    }
    container._usdDisposed = true;
    for (const group of container.animationGroups ?? []) {
        group.isPlaying = false;
        group._stopped = true;
    }
    container._usdMeshes.forEach(disposeMeshGpu);
    container._usdTextures.forEach(releaseTexture);
    container._usdMeshes.length = 0;
    container._usdTextures.length = 0;
}
