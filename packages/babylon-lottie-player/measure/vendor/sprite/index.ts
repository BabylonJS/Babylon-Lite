// Public API of the measurement-only sprite reference.
//
// The public API is the functional WORKER player — `CreatePlayer` plus `PreWarmPlayerAsync` /
// `PlayAnimationAsync` / `DisposePlayer` — which renders off the main thread on an OffscreenCanvas
// (the production path). The main-thread player used for local testing / debugging (and as a
// no-OffscreenCanvas fallback) is the `localPlayerRuntime` functions (`CreateLocalPlayer` /
// `PlayLocalAnimationAsync` / `DisposeLocalPlayer`); they are intentionally NOT public — import them
// directly from "./localPlayerRuntime" when needed.
export type { AnimationConfiguration } from "./animationConfiguration";
export { CreatePlayer, PreWarmPlayerAsync, PlayAnimationAsync, DisposePlayer } from "./playerRuntime";
export type { PlayerState } from "./playerRuntime";
export type { AnimationInput } from "./types";
export type { RawLottieAnimation } from "./parsing/rawTypes";
