// Tiny always-loaded forwarder for the per-frame animation tick. The real implementation
// (state sync + controller advance + writeback) lives in the dynamically-loaded animation
// module and registers itself here when the first animation group is created. This keeps the
// always-loaded scene render loop free of the animation logic (and of animation-group.ts),
// while staying fully synchronous: a scene cannot hold animation groups unless the animation
// module already loaded and registered the implementation, which happens before the first
// rendered frame can call tickAnimation.

import type { EngineContext } from "../engine/engine.js";
import type { AnimationGroup } from "./animation-group.js";

type TickAnimationFn = (group: AnimationGroup, deltaMs: number, engine?: EngineContext) => void;

let _tickAnimationImpl: TickAnimationFn | null = null;

/** @internal Register the real tick implementation. Called by the animation group factories. */
export function _setTickAnimationImpl(impl: TickAnimationFn): void {
    _tickAnimationImpl = impl;
}

/** @internal Advance animation by deltaMs. Forwards to the implementation registered when the
 *  first animation group was created; a no-op before any group exists. */
export function tickAnimation(group: AnimationGroup, deltaMs: number, engine?: EngineContext): void {
    _tickAnimationImpl?.(group, deltaMs, engine);
}
