import type { Task } from "../frame-graph/task.js";
import type { ComputeStorageTexture } from "../resource/compute-storage-texture.js";
import { _supportsComputeRenderMipmaps } from "../resource/compute-storage-mip-support.js";
import { prepareComputeMipmaps, recordPreparedComputeMipmaps } from "./compute-mipmap-preparation.js";

/** Create a task that regenerates mip chains for sampled 2D compute storage textures. */
export function createComputeStorageTextureMipmapsTask(name: string, resources: readonly ComputeStorageTexture[]): Task {
    if (resources.length === 0) {
        throw new Error("Compute storage texture mipmap task requires at least one resource.");
    }
    const engine = resources[0]!._engine;
    const textures = [...resources];
    for (const resource of textures) {
        if (
            resource._engine !== engine ||
            resource._destroyed ||
            !_supportsComputeRenderMipmaps(engine, resource.viewDimension, resource.format, !!resource.sampledTexture) ||
            resource._texture.mipLevelCount <= 1 ||
            !resource.computeTexture
        ) {
            throw new Error(
                "Compute storage texture mipmap task requires same-engine sampled 2D filterable-float resources created with mipMaps: true; rgba8snorm also requires texture-formats-tier1."
            );
        }
    }
    const prepared = textures.map((resource) => prepareComputeMipmaps(engine, resource._texture));
    return {
        name,
        engine,
        _passes: [],
        record(): void {
            return;
        },
        execute(): number {
            for (let i = 0; i < textures.length; i++) {
                const resource = textures[i]!;
                if (resource._destroyed) {
                    throw new Error(`Compute storage texture mipmap task "${name}" contains a disposed resource.`);
                }
                recordPreparedComputeMipmaps(engine._currentEncoder, prepared[i]!);
            }
            return 0;
        },
        dispose(): void {
            textures.length = 0;
        },
    };
}
