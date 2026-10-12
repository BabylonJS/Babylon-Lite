// Self-hosted engine entry for the Lite Playground runtime.
//
// User snippets `import { ... } from "@babylonjs/lite"`. The runner iframe's
// import map resolves that bare specifier to the ESM this file is built into
// (served at /engine/dev/index.js). Re-exporting the whole public surface keeps
// the playground runtime in lockstep with the workspace engine source ("nightly"),
// while pinned versions are loaded from a CDN instead (see runner import map).
export * from "babylon-lite";

import { createEngine as createLiteEngine } from "babylon-lite";
import type { EngineContext, EngineOptions, RenderCanvas } from "babylon-lite";

/**
 * Playground-only wrapper that lets the runner discover the engine created by a
 * snippet without requiring snippets or Babylon Lite itself to know about Inspector.
 */
export async function createEngine(canvas: RenderCanvas, options?: EngineOptions): Promise<EngineContext> {
    const engine = await createLiteEngine(canvas, options);
    window.dispatchEvent(new CustomEvent("babylon-lite-playground-engine-created", { detail: engine }));
    return engine;
}
