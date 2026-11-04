import type { PickingInfo } from "./picking-info.js";
import type { Ray } from "./ray.js";

export function tracePick(
    label: string,
    input: readonly number[],
    ray: Ray | null,
    pickId: number,
    depth: number,
    hit: boolean,
    unresolved = false,
    mesh = "",
    thinInstanceIndex = -1,
    info?: PickingInfo
): void {
    const [x, y, pickX, pickY, px, py, backingWidth, backingHeight, clientWidth, clientHeight, viewportX, viewportY, viewportWidth, viewportHeight] = input;
    console.trace("pick-debug", {
        label,
        input: {
            x,
            y,
            pickX,
            pickY,
            px,
            py,
            backingWidth,
            backingHeight,
            clientWidth,
            clientHeight,
            viewport: { x: viewportX, y: viewportY, width: viewportWidth, height: viewportHeight },
        },
        ray,
        pickId,
        depth,
        hit,
        ...(unresolved ? { unresolved: true } : {}),
        ...(hit ? { mesh, thinInstanceIndex, pickedPoint: info?.pickedPoint, distance: info?.distance } : {}),
    });
}
