/// <reference types="node" />
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite-gl");
const DIST = resolve(PACKAGE_DIR, "dist");

// Invoke binaries directly via the current node executable so the test does
// not depend on PATH (which may not contain pnpm/npx in every runner).
const NODE = process.execPath;
const VITE_JS = resolve(PACKAGE_DIR, "node_modules/vite/bin/vite.js");
const TSC_JS = resolve(ROOT, "node_modules/typescript/bin/tsc");

function typecheckDts(dts: string) {
    return spawnSync(NODE, [TSC_JS, "--noEmit", "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--lib", "es2022,dom,dom.iterable", dts], {
        cwd: PACKAGE_DIR,
        encoding: "utf-8",
    });
}

describe("babylon-lite-gl build output", () => {
    it("builds, ships a trimmed public API, and exposes the documented exports", async () => {
        // Build the package to produce dist/.
        const build = spawnSync(NODE, [VITE_JS, "build"], { cwd: PACKAGE_DIR, encoding: "utf-8" });
        if (build.status !== 0) {
            throw new Error(`babylon-lite-gl build failed:\n${build.stdout ?? ""}${build.stderr ?? ""}`);
        }

        // Both public entries plus the publish manifest must be emitted.
        for (const file of ["index.js", "index.d.ts", "html-texture.js", "html-texture.d.ts", "sprites.js", "sprites.d.ts", "package.json"]) {
            expect(existsSync(resolve(DIST, file)), `missing dist/${file}`).toBe(true);
        }

        // The emitted manifest is the scoped npm name with both subpath exports.
        const pkg = JSON.parse(readFileSync(resolve(DIST, "package.json"), "utf-8")) as { name?: string; exports?: Record<string, unknown> };
        expect(pkg.name).toBe("@babylonjs/lite-gl");
        expect(pkg.exports?.["."]).toBeDefined();
        expect(pkg.exports?.["./html-texture"]).toBeDefined();
        expect(pkg.exports?.["./sprites"]).toBeDefined();

        // The @internal trim pass must strip every underscored member from the
        // public declarations — no internal surface may leak to consumers.
        for (const dts of ["index.d.ts", "html-texture.d.ts", "sprites.d.ts"]) {
            const content = readFileSync(resolve(DIST, dts), "utf-8");
            const leak = content.match(/^\s+_[A-Za-z]\w*[?:(]/m);
            expect(leak, `internal member leaked into dist/${dts}: ${leak ? leak[0] : ""}`).toBeNull();
        }

        // The generated declarations type-check in isolation (no skipLibCheck),
        // catching any internal-only types leaking into the public surface.
        for (const dts of ["index.d.ts", "html-texture.d.ts", "sprites.d.ts"]) {
            const result = typecheckDts(resolve(DIST, dts));
            if (result.status !== 0) {
                throw new Error(`dist/${dts} has TypeScript errors:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
            }
            expect(result.status).toBe(0);
        }

        // The built ESM entry exposes the documented runtime exports.
        const mod = (await import(pathToFileURL(resolve(DIST, "index.js")).href)) as Record<string, unknown>;
        for (const name of ["createGLEngine", "createEffect", "createEffectWrapper", "applyEffectWrapper", "drawEffect", "runRenderLoop", "loadTexture2D", "setBlendMode"]) {
            expect(typeof mod[name], `export ${name}`).toBe("function");
        }
        // The blend-mode preset table is a value export, not a function.
        expect(typeof mod.GLBlendMode, "export GLBlendMode").toBe("object");

        // The /html-texture sub-entry resolves and exposes its factory.
        const htmlTex = (await import(pathToFileURL(resolve(DIST, "html-texture.js")).href)) as Record<string, unknown>;
        expect(typeof htmlTex.createHtmlElementTexture).toBe("function");

        // The /sprites sub-entry resolves and exposes its renderer factory.
        const sprites = (await import(pathToFileURL(resolve(DIST, "sprites.js")).href)) as Record<string, unknown>;
        for (const name of ["createSpriteRenderer", "renderSprites", "setSpriteRendererTexture", "disposeSpriteRenderer"]) {
            expect(typeof sprites[name], `sprites export ${name}`).toBe("function");
        }

        // Resolve each public subpath THROUGH the emitted exports map (not a
        // hard-coded dist/*.js path) — this is the contract real consumers resolve
        // against, so a broken/renamed exports target or missing types file is
        // caught here even though the direct-import checks above pass.
        const distPkg = JSON.parse(readFileSync(resolve(DIST, "package.json"), "utf-8")) as {
            exports: Record<string, { import?: string; types?: string }>;
        };
        const subpathProbes: Array<{ subpath: string; expected: string }> = [
            { subpath: ".", expected: "createGLEngine" },
            { subpath: "./html-texture", expected: "createHtmlElementTexture" },
            { subpath: "./sprites", expected: "createSpriteRenderer" },
        ];
        for (const { subpath, expected } of subpathProbes) {
            const entry = distPkg.exports[subpath];
            expect(entry?.import, `exports["${subpath}"].import missing`).toBeDefined();
            expect(entry?.types, `exports["${subpath}"].types missing`).toBeDefined();
            const importTarget = resolve(DIST, entry!.import!);
            const typesTarget = resolve(DIST, entry!.types!);
            expect(existsSync(importTarget), `exports["${subpath}"] import -> ${entry!.import} missing on disk`).toBe(true);
            expect(existsSync(typesTarget), `exports["${subpath}"] types -> ${entry!.types} missing on disk`).toBe(true);
            const resolved = (await import(pathToFileURL(importTarget).href)) as Record<string, unknown>;
            expect(typeof resolved[expected], `exports["${subpath}"] should expose ${expected}`).toBe("function");
        }
    }, 300_000);
});
