// PlayAnimation (BJS FlowGraphPlayAnimationBlock, glTF op `animation/start`).
// Async execution block: starts an AnimationGroup (resolved by glTF animation
// index from `env.animations`), fires `out` immediately so sync flow continues,
// and fires `done` when the animation ends.
//
// LITE DIVERGENCE: BJS wires animation/start to [PlayAnimation, ArrayIndex,
// GLTFDataProvider]. Lite pre-resolves the animation array in the loader and
// drives playback through scene-owned `env.caps` (no scene reference in the
// block). `from`/`to` frame-range playback is a Phase 3 refinement; Phase 2
// honors `speed` + `loop`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import type { AnimationGroup } from "../../../animation/animation-group.js";
import { activateSignal, addPending, getDataValue } from "../../runtime.js";
import { sigIn, sigOut, sockIn } from "../../sockets.js";

export const playAnimationDef: FgBlockDef = {
    type: FgBlockType.PlayAnimation,
    build: () => ({
        dataIn: [
            sockIn("animation", FgType.Reference),
            sockIn("speed", FgType.Number, 1),
            sockIn("loop", FgType.Boolean, false),
            sockIn("from", FgType.Number, 0),
            sockIn("to", FgType.Number),
        ],
        signalIn: [sigIn("in")],
        signalOut: [sigOut("out"), sigOut("done"), sigOut("error")],
    }),
    execute(block, ctx, env) {
        const index = toIndex(getDataValue(ctx, env, block, "animation"));
        const group = index === undefined ? undefined : env.animations[index];
        if (!group || !env.caps.playAnimation) {
            activateSignal(ctx, env, block, "error");
            return;
        }
        const speed = getDataValue(ctx, env, block, "speed") as number;
        const loop = getDataValue(ctx, env, block, "loop") as boolean;
        env.caps.playAnimation(group, { speed, loop });
        activateSignal(ctx, env, block, "out");

        const task = addPending(ctx, block, { group });
        if (env.caps.onAnimationEnd) {
            task.state.unsub = env.caps.onAnimationEnd(group, () => {
                task.done = true;
                activateSignal(ctx, env, block, "done");
            });
        }
    },
    onTick(block, ctx, env, _deltaMs, task) {
        // Fallback completion when no onAnimationEnd capability is wired: a
        // non-looping group that stopped playing is finished.
        if (task.state.unsub) {
            return;
        }
        const group = task.state.group as AnimationGroup | undefined;
        if (group && !group.isPlaying) {
            task.done = true;
            activateSignal(ctx, env, block, "done");
        }
    },
    cancelPending(block, ctx) {
        for (const task of ctx.pending) {
            if (task.blockId === block.id) {
                (task.state.unsub as (() => void) | undefined)?.();
            }
        }
    },
};

function toIndex(value: unknown): number | undefined {
    if (typeof value === "string") {
        const match = /^\/animations\/(\d+)\/?$/.exec(value);
        return match ? Number(match[1]) : undefined;
    }
    if (typeof value === "number") {
        return value | 0;
    }
    if (typeof value === "object" && value !== null && "value" in value) {
        return (value as { value: number }).value | 0;
    }
    return undefined;
}
