import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite");
const DIST_DIR = resolve(PACKAGE_DIR, "dist");
const DTS_PATH = resolve(DIST_DIR, "index.d.ts");
const PACKAGE_JSON_PATH = resolve(DIST_DIR, "package.json");

// Invoke binaries directly via their JS entry points and the current node
// executable, so the test does not depend on PATH (which may not contain
// pnpm/npx when launched from the VS Code Vitest extension).
const NODE = process.execPath;
const VITE_JS = resolve(PACKAGE_DIR, "node_modules/vite/bin/vite.js");
const TSC_JS = resolve(ROOT, "node_modules/typescript/bin/tsc");

// Build babylon-lite once for all dist/* assertions in this file.
beforeAll(() => {
    const build = spawnSync(NODE, [VITE_JS, "build"], {
        cwd: PACKAGE_DIR,
        encoding: "utf-8",
    });
    if (build.status !== 0) {
        throw new Error(`babylon-lite build failed:\n${build.stdout ?? ""}${build.stderr ?? ""}`);
    }
}, 300_000);

describe("dist/index.d.ts", () => {
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
            const clickable = output.replace(/(^|\s)(dist[\\/][^\s(]+)\((\d+),(\d+)\)/g, (_m, lead: string, rel: string, line: string, col: string) => {
                const abs = resolve(PACKAGE_DIR, rel).replace(/\\/g, "/");
                return `${lead}${abs}:${line}:${col}`;
            });
            throw new Error(`dist/index.d.ts has TypeScript errors (likely internal-only types leaking into the public API):\n${clickable}`);
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
        expect(external, `dist/index.d.ts leaks types from external modules: ${external.join(", ")}`).toEqual([]);
    });
});

describe("dist/package.json", () => {
    it("declares no runtime dependencies", () => {
        expect(existsSync(PACKAGE_JSON_PATH)).toBe(true);

        const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as Record<string, unknown>;

        // The published package must bundle every transitive runtime dep as an
        // opaque implementation detail — no `dependencies` and no
        // `peerDependencies` should ever appear in dist/package.json.
        expect(pkg.dependencies ?? {}).toEqual({});
        expect(pkg.peerDependencies ?? {}).toEqual({});
    });
});
