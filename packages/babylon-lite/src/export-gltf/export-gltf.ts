/** glTF 2.0 binary exporter entry point. */

import { VERSION } from "../engine/version.js";
import type { SceneContext } from "../scene/scene-core.js";
import { collectAnimatedNodes, exportAnimations } from "./export-animations.js";
import { cameraFixupOf, exportCamera } from "./export-cameras.js";
import type { ExportContext } from "./export-context.js";
import { createExportContext, snapshotExtras } from "./export-context.js";
import { frameGlb } from "./export-glb.js";
import type { GltfDocument } from "./export-gltf-types.js";
import { encodeImages } from "./export-images.js";
import { finalizeMaterials, resolveFolds } from "./export-materials.js";
import { collectRoots, exportNodeTrees } from "./export-nodes.js";
import { resolveTextureSlots } from "./export-textures.js";
import { exportLights } from "./ext/export-ext-lights-punctual.js";

/** Serialize a scene to a single binary glTF 2.0 (.glb) Blob.
 *
 *  Reads the scene's meshes, lights, camera, materials and animation groups. Image pixels are
 *  read back from the GPU and embedded as PNG. Resolves to a Blob of MIME type
 *  "model/gltf-binary". Treats the scene as read-only: every piece of scene state is read
 *  synchronously before the first `await`, so the render loop cannot change the result while the
 *  export is in flight. Valid before or after `registerScene`, but after `addToScene` (which sets
 *  parent links). Under a null engine, textured slots are omitted.
 *
 *  Content glTF cannot express, or that this exporter does not support yet (skins, texture
 *  sampling modes, original image bytes, …), logs a `console.warn` and degrades; see the
 *  architecture doc `docs/lite/architecture/60-gltf-exporter.md`.
 *
 *  @param scene - The scene to export.
 *  @returns A Blob holding the GLB file. */
export async function exportSceneAsGlb(scene: SceneContext): Promise<Blob> {
    const ctx = createExportContext(scene.surface.engine, `Babylon Lite v${VERSION}`);

    // 1. Capture (synchronous): read the scene, emit JSON and geometry, submit texture readbacks.
    const animated = collectAnimatedNodes(scene.animationGroups);
    const fixup = cameraFixupOf(scene.camera);
    const sweep = collectRoots(ctx, scene, animated, fixup);
    const assetExtras = snapshotExtras(ctx, sweep.assetExtras, "asset");
    if (assetExtras !== undefined) {
        ctx.doc.asset.extras = assetExtras;
    }
    exportNodeTrees(ctx, sweep);
    exportCamera(ctx, scene, fixup);
    exportLights(ctx, scene.lights);
    exportAnimations(ctx, scene.animationGroups);

    // 2. Settle every readback, then throw the first failure in submission order.
    await settleReadbacks(ctx);

    // 3. Resolve (synchronous): factor folds, then texture slots, then dependent values.
    resolveFolds(ctx);
    resolveTextureSlots(ctx);
    ctx.pixelCache.clear();
    ctx.resolvedPixels.clear();
    for (const callback of ctx.afterResolve) {
        callback();
    }
    finalizeMaterials(ctx);

    // 4. Encode images to PNG.
    await encodeImages(ctx);

    // 5. Assemble the GLB.
    const bin = ctx.buffers.finalize();
    const json = JSON.stringify(assembleDocument(ctx, bin.byteLength));
    return new Blob(frameGlb(json, bin), { type: "model/gltf-binary" });
}

/** Move settled readback pixels into `resolvedPixels`. A separate frame, so the settled results are
 *  unreachable once resolution clears the context maps. */
async function settleReadbacks(ctx: ExportContext): Promise<void> {
    const textures = [...ctx.pixelCache.keys()];
    const settled = await Promise.allSettled(ctx.pixelCache.values());
    for (let i = 0; i < textures.length; i++) {
        const result = settled[i]!;
        if (result.status === "rejected") {
            throw result.reason ?? new Error("Texture readback failed");
        }
        ctx.resolvedPixels.set(textures[i]!, result.value);
    }
}

/** The glTF document with only non-empty top-level members, in a fixed member order. */
function assembleDocument(ctx: ExportContext, binLength: number): GltfDocument {
    const d = ctx.doc;
    const doc: GltfDocument = { asset: d.asset };
    if (ctx.extensionsUsed.size > 0) {
        doc.extensionsUsed = [...ctx.extensionsUsed];
    }
    if (Object.keys(d.extensions).length > 0) {
        doc.extensions = d.extensions;
    }
    if (d.sceneNodes.length > 0) {
        doc.scene = 0;
        doc.scenes = [{ nodes: d.sceneNodes }];
    }
    const arrays = [
        ["nodes", d.nodes],
        ["meshes", d.meshes],
        ["materials", d.materials],
        ["textures", d.textures],
        ["images", d.images],
        ["cameras", d.cameras],
        ["animations", d.animations],
        ["accessors", ctx.buffers.accessors],
        ["bufferViews", ctx.buffers.bufferViews],
    ] as const;
    for (const [key, list] of arrays) {
        if (list.length > 0) {
            (doc as unknown as Record<string, unknown>)[key] = list;
        }
    }
    if (binLength > 0) {
        doc.buffers = [{ byteLength: binLength }];
    }
    return doc;
}
