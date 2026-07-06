import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite");
const BUILD_DIR = resolve(PACKAGE_DIR, "build");
const DTS_PATH = resolve(BUILD_DIR, "index.d.ts");
const PACKAGE_JSON_PATH = resolve(BUILD_DIR, "package.json");

// Invoke binaries directly via their JS entry points and the current node
// executable, so the test does not depend on PATH (which may not contain
// pnpm/npx when launched from the VS Code Vitest extension).
const NODE = process.execPath;
const VITE_JS = resolve(PACKAGE_DIR, "node_modules/vite/bin/vite.js");
const TSC_JS = resolve(ROOT, "node_modules/typescript/bin/tsc");

// Build babylon-lite once for all build/* assertions in this file. The package
// build is two Vite passes: `--mode dist` emits the prebundled CDN tree and the
// shared rolled-up `index.d.ts`; `--mode lib` emits the module-granular tree and the
// publish-ready `package.json`. Both are required for the assertions below.
beforeAll(() => {
    for (const mode of ["dist", "lib"]) {
        const build = spawnSync(NODE, [VITE_JS, "build", "--mode", mode], {
            cwd: PACKAGE_DIR,
            encoding: "utf-8",
        });
        if (build.status !== 0) {
            throw new Error(`babylon-lite build (--mode ${mode}) failed:\n${build.stdout ?? ""}${build.stderr ?? ""}`);
        }
    }
}, 300_000);

describe("build/index.d.ts", () => {
    it("type-checks cleanly with no references to internal-only types", () => {
        expect(existsSync(DTS_PATH)).toBe(true);

        // Type-check the generated declaration file in isolation, without
        // skipLibCheck, so that any unresolved (e.g. internal-only) types
        // leaking into the public API surface are caught.
        const result = spawnSync(
            NODE,
            [
                TSC_JS,
                "--noEmit",
                "--strict",
                "--target",
                "es2022",
                "--module",
                "esnext",
                "--moduleResolution",
                "bundler",
                "--lib",
                "es2022,dom,dom.iterable",
                "--types",
                "@webgpu/types",
                DTS_PATH,
            ],
            {
                cwd: PACKAGE_DIR,
                encoding: "utf-8",
            }
        );

        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        if (result.status !== 0) {
            // Rewrite tsc's relative paths (e.g. "dist/index.d.ts(619,52):")
            // into absolute paths so they're clickable in the VS Code terminal
            // / test output panel.
            const clickable = output.replace(/(^|\s)(build[\\/][^\s(]+)\((\d+),(\d+)\)/g, (_m, lead: string, rel: string, line: string, col: string) => {
                const abs = resolve(PACKAGE_DIR, rel).replace(/\\/g, "/");
                return `${lead}${abs}:${line}:${col}`;
            });
            throw new Error(`build/index.d.ts has TypeScript errors (likely internal-only types leaking into the public API):\n${clickable}`);
        }
        expect(result.status).toBe(0);
    }, 300_000);

    it("does not reference any external (npm) modules", () => {
        expect(existsSync(DTS_PATH)).toBe(true);

        const dts = readFileSync(DTS_PATH, "utf-8");

        // Collect every module specifier the .d.ts file refers to via:
        //   - top-level `import ... from "X"` declarations
        //   - top-level `export ... from "X"` re-exports
        //   - inline `import("X").Y` type expressions
        //   - triple-slash `<reference types="X" />` directives
        const specifiers = new Set<string>();
        for (const m of dts.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?\sfrom\s+["']([^"']+)["']/g)) {
            specifiers.add(m[1]!);
        }
        for (const m of dts.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
            specifiers.add(m[1]!);
        }
        for (const m of dts.matchAll(/\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/g)) {
            specifiers.add(m[1]!);
        }

        // Any specifier that is not a relative path is a leaked external type:
        // the rolled-up d.ts is supposed to be fully self-contained so that
        // consumers never need to install any of our build-time dependencies.
        const external = [...specifiers].filter((s) => !s.startsWith("./") && !s.startsWith("../"));
        expect(external, `build/index.d.ts leaks types from external modules: ${external.join(", ")}`).toEqual([]);
    });
});

describe("build/package.json", () => {
    it("declares no runtime dependencies and only strictly-optional allowlisted peers", () => {
        expect(existsSync(PACKAGE_JSON_PATH)).toBe(true);

        const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as Record<string, unknown>;

        // The published package must bundle every transitive *runtime* dep as an
        // opaque implementation detail, so `dependencies` is always empty and a
        // plain `npm i @babylonjs/lite` (or CDN usage) pulls in nothing else.
        expect(pkg.dependencies ?? {}).toEqual({});

        // A small, curated allowlist of OPTIONAL peer dependencies is permitted.
        // These are never bundled and — being optional — are never auto-installed
        // or warned about by npm/pnpm/yarn when the corresponding feature is unused:
        //   - @babylonjs/havok: injected by the caller into `createHavokWorld()`;
        //     Lite never imports it. The peer entry only advertises the supported range.
        //   - @webgpu/types: ambient/global types referenced by the public .d.ts;
        //     TypeScript consumers need them at compile time.
        // Every allowlisted peer MUST be marked optional. Keep this allowlist in sync
        // with `emitPackageJson()` in packages/babylon-lite/vite.config.ts.
        const ALLOWED_OPTIONAL_PEERS = ["@babylonjs/havok", "@webgpu/types"];
        const peers = (pkg.peerDependencies ?? {}) as Record<string, string>;
        const peerMeta = (pkg.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;

        // The declared peers must be EXACTLY the allowlist: no unexpected peer may
        // leak in, and — just as importantly — the whole `peerDependencies` block
        // must not be accidentally dropped from `emitPackageJson()`, which would
        // silently regress the feature while still passing a subset check.
        expect(Object.keys(peers).sort()).toEqual([...ALLOWED_OPTIONAL_PEERS].sort());

        // ...and every one of them must be strictly optional so no package manager
        // errors or auto-installs when the corresponding feature is unused.
        for (const name of ALLOWED_OPTIONAL_PEERS) {
            expect(peerMeta[name]?.optional, `peer dependency '${name}' must be marked optional in peerDependenciesMeta`).toBe(true);
        }
    });
});
