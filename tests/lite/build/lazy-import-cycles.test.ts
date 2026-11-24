/**
 * Lazy-import cycle guard for the shipped `build/lib` tree.
 *
 * A module loaded through `import()` must never statically reach (directly or transitively) the
 * module that lazy-loads it. Such a cycle makes the lazy chunk look like it keeps its own importer
 * alive. Rolldown (Vite 8) then emits the lazy chunk, plus every chunk that importer lazy-loads, even
 * when the application never reaches that code. The flow-graph block registry did this: an empty
 * scene built with Vite 8 emitted ~150 chunks, 135 of them flow-graph blocks that nothing imported.
 * See https://forum.babylonjs.com/t/lite-something-wrong-with-treeshaking-bundling-with-vite/64889.
 *
 * Fix a failure by moving what the lazy module needs out of its loader, into a leaf module both can
 * import (e.g. `physics/physics-motion-types.ts`, `engine/gpu-task-timing-snapshot.ts`).
 */
import { readdirSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import ts from "typescript";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BUILD_LIB_DIR, LIB_ENTRY, cleanupTempDirs, ensureLibBuilt, makeTempEntry } from "./bundler-harness";

interface ModuleImports {
    readonly staticImports: string[];
    readonly dynamicImports: string[];
}

/** First-party `build/lib` JS files, including shared `_chunks` but not bundled vendor runtimes. */
function listLibFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== "vendor") {
                    walk(path);
                }
            } else if (entry.name.endsWith(".js")) {
                out.push(path);
            }
        }
    };
    walk(BUILD_LIB_DIR);
    return out;
}

/** Relative static (`import`/`export … from`) and literal dynamic (`import("…")`) edges of one file. */
function readImports(file: string): ModuleImports {
    const source = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const staticImports: string[] = [];
    const dynamicImports: string[] = [];
    const resolveRelative = (specifier: string): string | undefined => (specifier.startsWith(".") ? resolve(dirname(file), specifier) : undefined);
    const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            const target = resolveRelative(node.moduleSpecifier.text);
            if (target) {
                staticImports.push(target);
            }
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const [arg] = node.arguments;
            const target = arg && ts.isStringLiteralLike(arg) ? resolveRelative(arg.text) : undefined;
            if (target) {
                dynamicImports.push(target);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return { staticImports, dynamicImports };
}

/** Every `loader -import()-> lazy` edge whose target statically reaches back to its loader. */
function findLazyImportCycles(): string[] {
    const graph = new Map(listLibFiles().map((file) => [file, readImports(file)]));
    const closures = new Map<string, Set<string>>();
    const staticClosure = (file: string): Set<string> => {
        let seen = closures.get(file);
        if (!seen) {
            seen = new Set();
            const queue = [file];
            while (queue.length > 0) {
                for (const next of graph.get(queue.pop()!)?.staticImports ?? []) {
                    if (!seen.has(next)) {
                        seen.add(next);
                        queue.push(next);
                    }
                }
            }
            closures.set(file, seen);
        }
        return seen;
    };
    const cycles: string[] = [];
    for (const [loader, { dynamicImports }] of graph) {
        for (const lazy of dynamicImports) {
            if (lazy === loader || staticClosure(lazy).has(loader)) {
                cycles.push(`${relative(BUILD_LIB_DIR, loader)} -import()-> ${relative(BUILD_LIB_DIR, lazy)}`);
            }
        }
    }
    return cycles.sort();
}

beforeAll(ensureLibBuilt);
afterAll(cleanupTempDirs);

describe("@babylonjs/lite lazy-import cycles", () => {
    it("no lazily imported module statically reaches the module that lazy-loads it", () => {
        const cycles = findLazyImportCycles();
        expect(
            cycles,
            "Each lazily imported module below statically imports (directly or transitively) the module that " +
                "lazy-loads it. Rolldown/Vite 8 then emits these chunks for apps that never use them. Move what the " +
                "lazy module needs into a leaf module that both can import.\n" +
                cycles.join("\n")
        ).toEqual([]);
    });

    it("a Vite 8 (Rolldown) build of an empty scene emits only chunks reachable from the entry", async () => {
        const entry = makeTempEntry(
            `import { createEngine, createSceneContext, registerScene, startEngine } from ${JSON.stringify(LIB_ENTRY)};\n` +
                `const engine = await createEngine(document.querySelector("canvas"));\n` +
                `const scene = createSceneContext(engine);\n` +
                `await registerScene(scene);\n` +
                `await startEngine(engine);\n`
        );
        const result = (await build({
            configFile: false,
            logLevel: "silent",
            root: dirname(entry),
            build: {
                write: false,
                minify: false,
                target: "esnext",
                modulePreload: false,
                rollupOptions: { input: entry },
            },
        })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
        const output = (Array.isArray(result) ? result[0]! : result).output;
        const chunks = new Map(output.filter((o): o is Rolldown.OutputChunk => o.type === "chunk").map((chunk) => [chunk.fileName, chunk]));

        const reachable = new Set<string>();
        const queue = [...chunks.values()].filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
        while (queue.length > 0) {
            const name = queue.pop()!;
            if (reachable.has(name)) {
                continue;
            }
            reachable.add(name);
            const chunk = chunks.get(name);
            queue.push(...(chunk?.imports ?? []), ...(chunk?.dynamicImports ?? []));
        }
        const orphans = [...chunks.keys()].filter((name) => !reachable.has(name)).sort();
        expect(orphans, `Rolldown emitted ${orphans.length} of ${chunks.size} chunks that nothing imports:\n${orphans.join("\n")}`).toEqual([]);
    }, 180_000);
});
