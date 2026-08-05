// Self-hosted engine entry for the Lite Playground runtime.
//
// User snippets `import { ... } from "@babylonjs/lite"`. The runner iframe's
// import map resolves that bare specifier to the ESM this file is built into
// (served at /engine/dev/index.js). Re-exporting the whole public surface keeps
// the playground runtime in lockstep with the workspace engine source ("nightly"),
// while pinned versions are loaded from a CDN instead (see runner import map).
export * from "babylon-lite";
