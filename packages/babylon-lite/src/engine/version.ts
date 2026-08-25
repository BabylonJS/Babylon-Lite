// `__BL_VERSION__` is replaced at build time with the resolved package version
// by the lite Vite build (see `define` in packages/babylon-lite/vite.config.ts).
// The release pipeline resolves the published npm version *before* `pnpm build`,
// so the published bundle reports the version it actually ships as. When the
// source is consumed directly (lab dev server, unit tests) the define is absent,
// so the `typeof` guard falls back to the literal dev version below.
declare const __BL_VERSION__: string;

/** Babylon Lite version string. */
export const VERSION: string = /* @__PURE__ */ (() => (typeof __BL_VERSION__ !== "undefined" ? __BL_VERSION__ : "0.1.0"))();

/** @internal Startup banner text, also stamped onto every DOM canvas Babylon Lite renders
 *  into as its `data-engine` attribute (see `_buildSurface`). It lives in this standalone
 *  module — rather than in `engine.ts` — so `surface.ts` can read it without a runtime
 *  import cycle back into `engine.ts` (which imports `surface.js` for value). */
export const _ENGINE_TAG = `Babylon Lite v${VERSION}`;
