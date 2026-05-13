/** Public Gaussian-Splatting loader.
 *
 *  `loadSplat(scene, url)` fetches a `.ply` (or pre-converted `.splat`) asset,
 *  parses it on the main thread, uploads its textures + thin-instance buffer
 *  to the GPU, spawns the sort worker, registers the GS renderable on the
 *  scene, and returns the resulting `GaussianSplattingMesh`.
 *
 *  Bundle-size discipline:
 *    • The compressed-PLY parser (`splat-ply-compressed.ts`) is dynamic-
 *      imported only when `isPlyCompressedOrSH(data)` is true so plain `.ply`
 *      scenes (e.g. scene 120) skip both the parser code *and* the SH textures.
 *    • The SH-aware render pipeline (`gaussian-splatting-pipeline-sh.ts`) is
 *      dynamic-imported only when the parsed asset carries SH coefficients.
 *
 *  `mesh.firstSortReady` resolves once the worker has produced its first
 *  depth-sorted splat-index buffer — wait on that promise before flagging the
 *  canvas as ready in your scene script. */

import type { EngineContextInternal } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import { isPly, isPlyCompressedOrSH, convertPlyToSplat } from "./splat-ply-parser.js";
import { buildSplatGeometry, type ParsedSplat } from "./splat-data.js";
import type { GaussianSplattingMesh } from "../mesh/gaussian-splatting-mesh.js";
import { createGaussianSplattingMesh } from "../mesh/gaussian-splatting-mesh.js";
import { attachGaussianSplattingMesh } from "../mesh/gaussian-splatting-pipeline.js";
import SplatSortWorker from "./splat-sort-worker.ts?worker&inline";

/** Build the mesh + renderable from a parsed splat asset. Exported so SOG/SPZ
 *  loaders can share the same plumbing (worker, pipeline attach, SH dispatch). */
export async function attachParsedSplat(scene: SceneContext, name: string, parsed: ParsedSplat): Promise<GaussianSplattingMesh> {
    const geom = buildSplatGeometry(parsed.data);
    const worker = new SplatSortWorker({ name: "babylon-lite-splat-sort" });
    const eng = scene.engine as EngineContextInternal;
    const mesh = createGaussianSplattingMesh(eng, name, geom, worker, parsed);

    if (parsed.sh && parsed.shDegree && parsed.shDegree > 0) {
        const { attachGaussianSplattingMeshSH } = await import("../mesh/gaussian-splatting-pipeline-sh.js");
        attachGaussianSplattingMeshSH(scene, mesh, parsed.sh);
    } else {
        attachGaussianSplattingMesh(scene, mesh);
    }
    return mesh;
}

/** Fetch + parse a Gaussian-splat asset and attach it to `scene`. */
export async function loadSplat(scene: SceneContext, url: string): Promise<GaussianSplattingMesh> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`loadSplat: HTTP ${response.status} for ${url}`);
    }
    const data = await response.arrayBuffer();

    let parsed: ParsedSplat;
    if (isPly(data)) {
        if (isPlyCompressedOrSH(data)) {
            const { convertCompressedPlyToParsedSplat } = await import("./splat-ply-compressed.js");
            parsed = convertCompressedPlyToParsedSplat(data);
        } else {
            parsed = convertPlyToSplat(data);
        }
        if (parsed.data.byteLength === 0) {
            throw new Error(`loadSplat: failed to parse PLY at ${url} (unsupported property layout)`);
        }
    } else {
        // Allow pre-converted .splat files (same row layout) as a fast path.
        parsed = { data };
    }

    const name = url.substring(url.lastIndexOf("/") + 1) || "splat";
    return await attachParsedSplat(scene, name, parsed);
}
