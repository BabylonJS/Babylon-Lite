/**
 * Import-graph helpers for the shipped JS of the Lite packages (`build/lib` for `@babylonjs/lite`,
 * `dist` for `@babylonjs/lite-gl`). They parse the emitted JavaScript, so `import type` edges are
 * already erased and only runtime edges are seen.
 */
import { readdirSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import ts from "typescript";

interface ModuleImports {
    readonly staticImports: string[];
    readonly dynamicImports: string[];
}

/** Minimal shape of a Rollup/Rolldown output chunk needed for reachability. */
export interface ChunkLike {
    readonly type: string;
    readonly fileName: string;
    readonly isEntry?: boolean;
    readonly imports?: readonly string[];
    readonly dynamicImports?: readonly string[];
}

/** Every `.js` file under `root`, skipping directories named in `skipDirs`. */
export function listJsFiles(root: string, skipDirs: readonly string[] = []): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!skipDirs.includes(entry.name)) {
                    walk(path);
                }
            } else if (entry.name.endsWith(".js")) {
                out.push(path);
            }
        }
    };
    walk(root);
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

function readGraph(files: readonly string[]): Map<string, ModuleImports> {
    return new Map(files.map((file) => [file, readImports(file)]));
}

/** Every `loader -import()-> lazy` edge whose target statically reaches back to its loader. */
export function findLazyImportCycles(files: readonly string[], root: string): string[] {
    const graph = readGraph(files);
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
                cycles.push(`${relative(root, loader)} -import()-> ${relative(root, lazy)}`);
            }
        }
    }
    return cycles.sort();
}

/** Strongly connected components (size > 1, or a self-import) of the static import graph, each as a
 *  sorted, comma-separated list of root-relative paths. */
export function findStaticImportCycles(files: readonly string[], root: string): string[] {
    const graph = readGraph(files);
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const cycles: string[] = [];
    let next = 0;
    const connect = (v: string): void => {
        index.set(v, next);
        low.set(v, next);
        next++;
        stack.push(v);
        onStack.add(v);
        const edges = graph.get(v)!.staticImports;
        for (const w of edges) {
            if (!graph.has(w)) {
                continue;
            }
            if (!index.has(w)) {
                connect(w);
                low.set(v, Math.min(low.get(v)!, low.get(w)!));
            } else if (onStack.has(w)) {
                low.set(v, Math.min(low.get(v)!, index.get(w)!));
            }
        }
        if (low.get(v) === index.get(v)) {
            const component: string[] = [];
            let w: string;
            do {
                w = stack.pop()!;
                onStack.delete(w);
                component.push(w);
            } while (w !== v);
            if (component.length > 1 || edges.includes(v)) {
                cycles.push(
                    component
                        .map((file) => relative(root, file))
                        .sort()
                        .join(", ")
                );
            }
        }
    };
    for (const file of graph.keys()) {
        if (!index.has(file)) {
            connect(file);
        }
    }
    return cycles.sort();
}

/** File names of emitted chunks that no entry chunk reaches through static or dynamic imports. */
export function findOrphanChunks(output: readonly ChunkLike[]): string[] {
    const chunks = new Map(output.filter((o) => o.type === "chunk").map((chunk) => [chunk.fileName, chunk]));
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
    return [...chunks.keys()].filter((name) => !reachable.has(name)).sort();
}
