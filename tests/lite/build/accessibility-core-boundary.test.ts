import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

describe("accessibility core boundary", () => {
    it("tree-shakes an unused generic scene subscription", async () => {
        ensureLibBuilt();
        const baseline = await runRollup({
            entrySource: `import { addToScene, createSceneContext, disposeScene, removeFromScene } from ${JSON.stringify(LIB_ENTRY)};
console.log(addToScene, createSceneContext, disposeScene, removeFromScene);`,
            format: "es",
            minify: false,
        });
        const withUnusedSubscription = await runRollup({
            entrySource: `import { addToScene, createSceneContext, disposeScene, onSceneChange, removeFromScene } from ${JSON.stringify(LIB_ENTRY)};
console.log(addToScene, createSceneContext, disposeScene, removeFromScene);`,
            format: "es",
            minify: false,
        });

        expect(baseline.errors).toEqual([]);
        expect(withUnusedSubscription.errors).toEqual([]);
        expect(withUnusedSubscription.code).toBe(baseline.code);
        cleanupTempDirs();
    });

    it("bundles a generic scene subscriber without accessibility implementation", async () => {
        ensureLibBuilt();
        const result = await runRollup({
            entrySource: `import { addToScene, createSceneContext, onSceneChange, removeFromScene } from ${JSON.stringify(LIB_ENTRY)};
console.log(addToScene, createSceneContext, onSceneChange, removeFromScene);`,
            format: "es",
            minify: false,
        });

        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("AggregateError");
        for (const name of ["AccessibilityTag", "createSceneAccessibility", "data-lite-accessibility-node", "SceneAccessibility"]) {
            expect(result.code).not.toContain(name);
        }
        cleanupTempDirs();
    });

    it("keeps scene and runtime core source structurally accessibility-agnostic", () => {
        const root = resolve(import.meta.dirname, "../../../packages/babylon-lite/src");
        const files = ["scene/scene-core.ts", "scene/scene-remove.ts", "engine/engine.ts", "render/renderable.ts"];

        for (const relative of files) {
            const source = readFileSync(resolve(root, relative), "utf-8");
            const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
            const imports = ast.statements.filter(ts.isImportDeclaration).map((statement) => (ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ""));
            expect(imports.some((specifier) => specifier.includes("accessibility"))).toBe(false);

            const names: string[] = [];
            const visit = (node: ts.Node): void => {
                if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
                    names.push(node.name.text);
                }
                ts.forEachChild(node, visit);
            };
            visit(ast);
            expect(names.some((name) => name.toLowerCase().includes("accessibility"))).toBe(false);
        }
    });
});
