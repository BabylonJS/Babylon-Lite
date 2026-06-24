// StopAnimation (BJS FlowGraphStopAnimationBlock, glTF ops `animation/stop` and
// `animation/stopAt`). Execution block: stops an AnimationGroup resolved by glTF
// animation index, then fires `out` (or `error` when the index/capability is
// missing).
//
//  - `animation/stop`: stops immediately (resets to frame 0 via `stopAnimation`).
//  - `animation/stopAt`: an optional `stopAtFrame` input defers the stop — the
//    block fires `out` at once, then polls each tick and halts the group at the
//    requested frame (`stopAnimationAt`, which poses the target at that frame).
//
// LITE DIVERGENCE: BJS expands `animation/stopAt` to [StopAnimation, ArrayIndex,
// GLTFDataProvider]; Lite pre-resolves the animation array in the loader and
// drives playback through scene-owned `env.caps`. The deferred monitor handles
// forward playback (the common case) and also completes if the group stops on
// its own.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import type { AnimationGroup } from "../../../animation/animation-group.js";
import { activateSignal, addPending, getDataValue } from "../../runtime.js";
import { sigIn, sigOut, sockIn } from "../../sockets.js";

const DEFAULT_FRAME_RATE = 60;

export const stopAnimationDef: FgBlockDef = {
    type: FgBlockType.StopAnimation,
    build: () => ({
        dataIn: [sockIn("animation", FgType.Integer), sockIn("stopAtFrame", FgType.Number)],
        signalIn: [sigIn("in")],
        signalOut: [sigOut("out"), sigOut("error")],
    }),
    execute(block, ctx, env) {
        const index = toIndex(getDataValue(ctx, env, block, "animation"));
        const group = index === undefined ? undefined : env.animations[index];
        if (!group || !env.caps.stopAnimation) {
            activateSignal(ctx, env, block, "error");
            return;
        }

        // Deferred stop only when a `stopAtFrame` input is actually wired/provided
        // (an unwired socket reads as 0, which must NOT be treated as "stop at 0").
        const frameSocket = block.dataIn.find((s) => s.name === "stopAtFrame");
        const hasStopAt = !!(frameSocket && (frameSocket.source || frameSocket.defaultValue !== undefined)) && !!env.caps.stopAnimationAt;

        if (!hasStopAt) {
            env.caps.stopAnimation(group);
            activateSignal(ctx, env, block, "out");
            return;
        }

        const stopAtFrame = getDataValue(ctx, env, block, "stopAtFrame") as number;
        activateSignal(ctx, env, block, "out");
        addPending(ctx, block, { group, stopAtFrame });
    },
    onTick(_block, _ctx, env, _deltaMs, task) {
        const group = task.state.group as AnimationGroup | undefined;
        if (!group) {
            task.done = true;
            return;
        }
        const stopAtFrame = task.state.stopAtFrame as number;
        const currentFrame = group.currentTime * (group.frameRate || DEFAULT_FRAME_RATE);
        if (currentFrame >= stopAtFrame) {
            env.caps.stopAnimationAt?.(group, stopAtFrame);
            task.done = true;
        } else if (!group.isPlaying) {
            // Group ended before reaching the target frame — nothing left to stop.
            task.done = true;
        }
    },
};

function toIndex(value: unknown): number | undefined {
    if (typeof value === "number") {
        return value | 0;
    }
    if (typeof value === "object" && value !== null && "value" in value) {
        return (value as { value: number }).value | 0;
    }
    return undefined;
}
