import { createLogger, defineConfig } from "vite";
import { resolve } from "path";
import { execSync } from "child_process";
import { readFileSync } from "fs";

/**
 * Resolve the version the self-hosted "nightly" engine should report. The engine's
 * runtime `VERSION` is baked in via the `__BL_VERSION__` define; without it the
 * engine falls back to its source `package.json` (0.1.0), which is stale because
 * the real version is only stamped during the npm publish pipeline.
 *
 * So that nightly reflects the latest *published* release, resolve the base version
 * from (in order): an explicit `PACKAGE_VERSION` env (set by the deploy pipeline),
 * the newest `npm-lite-v*` git tag, then the engine source `package.json`. The
 * result is suffixed `-nightly` to mark it as a tracking build (not an exact release).
 */
function resolveNightlyVersion(): string {
    const fromEnv = process.env.PACKAGE_VERSION?.trim();
    if (fromEnv) {
        return fromEnv;
    }
    let base: string | undefined;
    try {
        const tags = execSync('git tag --list "npm-lite-v*"', { cwd: __dirname, encoding: "utf8" })
            .split("\n")
            .map((tag) => tag.trim().replace(/^npm-lite-v/, ""))
            .filter(Boolean);
        base = tags.sort(compareSemver).at(-1);
    } catch {
        base = undefined;
    }
    if (!base) {
        const pkgPath = resolve(__dirname, "../packages/babylon-lite/package.json");
        const { version } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
        base = version ?? "0.1.0";
    }
    return `${base}-nightly`;
}

/** Ascending semver comparison sufficient for `MAJOR.MINOR.PATCH` release tags. */
function compareSemver(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

const NIGHTLY_VERSION = resolveNightlyVersion();

// Quiet the benign "Module … has been externalized for browser compatibility"
// warnings emitted while bundling the engine: the wasm glue in manifold-3d /
// recast-navigation references Node built-ins (module/fs/path) that are only
// touched by lazily-imported features, never on the default render path.
const logger = createLogger();
const baseWarn = logger.warn;
logger.warn = (msg, options) => {
    if (typeof msg === "string" && msg.includes("externalized for browser compatibility")) {
        return;
    }
    baseWarn(msg, options);
};

/**
 * Builds the self-hosted "nightly" engine bundle the runner iframe imports as
 * `@babylonjs/lite`. Emits an ES module (with code-split dynamic chunks kept
 * separate, so wasm-backed features stay lazy) into `public/engine/dev/`, which
 * the playground dev server and production build both serve statically.
 *
 * Output: public/engine/dev/index.js (+ chunks). Run via `pnpm build:engine`,
 * which the `dev` and `build` scripts invoke automatically.
 */
export default defineConfig({
    publicDir: false,
    customLogger: logger,
    // Stamp the engine's runtime VERSION so nightly reports e.g. `1.4.0-nightly`
    // instead of the stale source fallback (0.1.0). Mirrors the engine's own
    // `__BL_VERSION__` define used by the npm publish build.
    define: {
        __BL_VERSION__: JSON.stringify(NIGHTLY_VERSION),
    },
    build: {
        outDir: resolve(__dirname, "public/engine/dev"),
        emptyOutDir: true,
        target: "esnext",
        minify: "esbuild",
        sourcemap: true,
        lib: {
            entry: resolve(__dirname, "src/engine-entry.ts"),
            formats: ["es"],
            fileName: () => "index.js",
        },
        rollupOptions: {
            output: {
                // Keep dynamic-import chunks separate so lazy/wasm features only
                // load when a snippet actually uses them.
                inlineDynamicImports: false,
                chunkFileNames: "_chunks/[name]-[hash].js",
            },
        },
    },
});
