/** Public Gaussian-Splatting loader.
 *
 *  `loadSplat(scene, url)` fetches a `.ply` (or pre-converted `.splat`) asset,
 *  parses it on the main thread, uploads its textures + thin-instance buffer
 *  to the GPU, spawns the sort worker, registers the GS renderable on the
 *  scene, and returns the resulting `GaussianSplattingMesh`.
 *
 *  Mirrors the convention of `loadSkybox` / `loadHdrEnvironment`: loaders that
 *  push renderables take `scene` directly so non-GS scenes never pull any
 *  GS-aware code into their bundle.
 *
 *  `mesh.firstSortReady` resolves once the worker has produced its first
 *  depth-sorted splat-index buffer — wait on that promise before flagging the
 *  canvas as ready in your scene script. */

import type { EngineContextInternal } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import { isPly, convertPlyToSplat } from "./splat-ply-parser.js";
import { buildSplatGeometry } from "./splat-data.js";
import type { GaussianSplattingMesh } from "../mesh/gaussian-splatting-mesh.js";
import { createGaussianSplattingMesh } from "../mesh/gaussian-splatting-mesh.js";
import { attachGaussianSplattingMesh } from "../mesh/gaussian-splatting-pipeline.js";
import SplatSortWorker from "./splat-sort-worker.ts?worker&inline";

/** Fetch + parse a Gaussian-splat asset and attach it to `scene`. */
export async function loadSplat(scene: SceneContext, url: string): Promise<GaussianSplattingMesh> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`loadSplat: HTTP ${response.status} for ${url}`);
    }
    const data = await response.arrayBuffer();

    let splatBuffer: ArrayBuffer;
    if (isPly(data)) {
        splatBuffer = convertPlyToSplat(data);
        if (splatBuffer.byteLength === 0) {
            throw new Error(`loadSplat: failed to parse PLY at ${url} (unsupported property layout)`);
        }
    } else {
        // Allow pre-converted .splat files (same row layout) as a fast path.
        splatBuffer = data;
    }

    const geom = buildSplatGeometry(splatBuffer);
    const worker = new SplatSortWorker({ name: "babylon-lite-splat-sort" });
    const eng = scene.engine as EngineContextInternal;
    const name = url.substring(url.lastIndexOf("/") + 1) || "splat";
    const mesh = createGaussianSplattingMesh(eng, name, geom, worker, splatBuffer);

    // Apply the BJS PLY-loader's Y-flip via the mesh's worldMatrix (mirrors
    // `gaussianSplatting.scaling.y *= -1.0` in @babylonjs/loaders' SPLAT/
    // splatFileLoader.ts).  Doing it via worldMatrix — rather than baking the
    // flip into the centres — is critical for visual parity: the
    // EWA / Vrk projection uses `modelView = view * world` so a worldMatrix-
    // level Y-flip reflects BOTH each splat's centre AND its covariance Σ.
    // Baking the flip into centres alone leaves Σ in PLY-space and the
    // anisotropic gaussians point in the wrong direction relative to their
    // world positions, dimming the rendered haze (visible as ~25/255 MAD vs
    // BJS).  Standard 3DGS PLYs (like Halo_Believe) carry no `chirality`/
    // `up_axis` properties so BJS' net transform is just `scaling.y = -1`.
    mesh.scaling.y = -1;

    attachGaussianSplattingMesh(scene, mesh);
    return mesh;
}
