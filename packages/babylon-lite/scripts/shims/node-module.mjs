// Browser-safe shim for the Node.js built-in `module` (a.k.a. `node:module`).
//
// `manifold-3d`'s Emscripten glue does `import { createRequire } from "module"` and
// calls `createRequire(import.meta.url)` — but only inside its ENVIRONMENT_IS_NODE
// branch, which never executes in a browser. Without this shim, Vite externalizes the
// builtin into a `__vite-browser-external` stub chunk. In the module-granular `lib`
// build that stub (a) is browser-hostile and (b) gets a real shared module merged into
// it by Rollup's chunker, breaking ESM linking in the browser. Aliasing the builtin to
// this real module keeps it bundled normally so no stub chunk is ever produced.

export function createRequire() {
    return () => {
        throw new Error("require() is not available in the browser build of @babylonjs/lite");
    };
}

export default { createRequire };
