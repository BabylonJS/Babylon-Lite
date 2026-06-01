import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite");
const DTS_PATH = resolve(PACKAGE_DIR, "dist/index.d.ts");

// Invoke binaries directly via their JS entry points and the current node
// executable, so the test does not depend on PATH (which may not contain
// pnpm/npx when launched from the VS Code Vitest extension).
const NODE = process.execPath;
const VITE_JS = resolve(PACKAGE_DIR, "node_modules/vite/bin/vite.js");
const TSC_JS = resolve(ROOT, "node_modules/typescript/bin/tsc");

describe("public API .d.ts", () => {
    it("builds and type-checks cleanly with no references to internal-only types", () => {
        // Build babylon-lite to produce dist/index.d.ts.
        const build = spawnSync(NODE, [VITE_JS, "build"], {
            cwd: PACKAGE_DIR,
            encoding: "utf-8",
        });
        if (build.status !== 0) {
            throw new Error(`babylon-lite build failed:\n${build.stdout ?? ""}${build.stderr ?? ""}`);
        }

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
});
