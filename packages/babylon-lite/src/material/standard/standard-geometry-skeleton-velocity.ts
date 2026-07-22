/** Double-buffered previous-bone state loaded only by skeletal geometry passes. */

import type { SkeletonData } from "../../animation/types.js";
import type { EngineContext } from "../../engine/engine.js";
import { TU } from "../../engine/gpu-flags.js";

/** @internal Per-mesh skeletal velocity state. */
export interface StandardGeometrySkeletonVelocityState {
    /** @internal Bind group sampling the initial previous-bone texture. */
    readonly _bindGroup: GPUBindGroup;
    /** @internal Upload current bones to the idle texture and return the prior texture's bind group. */
    _update(): GPUBindGroup;
    /** @internal */
    _dispose(): void;
}

/** @internal Create double-buffered previous-bone textures and their bind groups. */
export function createStandardGeometrySkeletonVelocity(
    engine: EngineContext,
    skeleton: SkeletonData,
    createBindGroup: (previousBones: GPUTexture) => GPUBindGroup
): StandardGeometrySkeletonVelocityState {
    const width = skeleton.boneCount * 4;
    const createTexture = (): GPUTexture =>
        engine._device.createTexture({
            size: [width, 1],
            format: "rgba32float",
            usage: TU.TEXTURE_BINDING | TU.COPY_DST,
        });
    const textures: [GPUTexture, GPUTexture] = [createTexture(), createTexture()];
    const write = (texture: GPUTexture): void => {
        engine._device.queue.writeTexture({ texture }, skeleton.boneMatrices as Float32Array<ArrayBuffer>, { bytesPerRow: skeleton.boneCount * 64 }, { width, height: 1 });
    };
    write(textures[0]);
    write(textures[1]);
    const bindGroups: [GPUBindGroup, GPUBindGroup] = [createBindGroup(textures[0]), createBindGroup(textures[1])];
    let previousIndex = 0;

    return {
        _bindGroup: bindGroups[0],
        _update() {
            const bindGroup = bindGroups[previousIndex]!;
            const nextIndex = 1 - previousIndex;
            write(textures[nextIndex]!);
            previousIndex = nextIndex;
            return bindGroup;
        },
        _dispose() {
            textures[0].destroy();
            textures[1].destroy();
        },
    };
}
