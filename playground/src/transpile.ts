import * as esbuild from "esbuild-wasm";
import esbuildWasmUrl from "esbuild-wasm/esbuild.wasm?url";

let initPromise: Promise<void> | null = null;

/**
 * Lazily initialise the esbuild-wasm runtime exactly once. The wasm binary is
 * resolved through Vite's asset pipeline (`?url`) so it is served locally.
 */
function ensureInitialized(): Promise<void> {
    if (!initPromise) {
        initPromise = esbuild.initialize({ wasmURL: esbuildWasmUrl });
    }
    return initPromise;
}

const LITE_SPECIFIER = "@babylonjs/lite";

/** A single compile/bundle diagnostic mapped to a 1-based editor location. */
export interface BuildDiagnostic {
    file: string;
    line: number;
    column: number;
    length: number;
    message: string;
}

/** Thrown by {@link transpile} when esbuild reports build errors, carrying editor-mappable diagnostics. */
export class TranspileError extends Error {
    readonly diagnostics: BuildDiagnostic[];
    constructor(diagnostics: BuildDiagnostic[]) {
        const summary = diagnostics[0]?.message ?? "Build failed";
        super(diagnostics.length > 1 ? `${summary} (+${diagnostics.length - 1} more)` : summary);
        this.name = "TranspileError";
        this.diagnostics = diagnostics;
    }
}

function toDiagnostics(messages: readonly esbuild.Message[]): BuildDiagnostic[] {
    return messages.map((message) => {
        const location = message.location;
        // esbuild prefixes virtual-namespace files as `virtual:<name>`; map back to the model name.
        const file = (location?.file ?? "").replace(/^virtual:/, "").replace(/^\.?\//, "");
        return {
            file,
            line: location?.line ?? 1,
            // esbuild columns are 0-based byte offsets; Monaco is 1-based.
            column: (location?.column ?? 0) + 1,
            length: location?.length ?? 1,
            message: message.text,
        };
    });
}

function loaderFor(name: string): esbuild.Loader {
    // `.tsx` needs the JSX-aware TS loader; the plain `ts` loader rejects JSX syntax.
    if (name.endsWith(".tsx")) {
        return "tsx";
    }
    if (name.endsWith(".js") || name.endsWith(".jsx")) {
        return "jsx";
    }
    if (name.endsWith(".json")) {
        return "json";
    }
    return "ts";
}

/** Resolve a relative import against its importer within the flat virtual file set. */
function resolveRelative(importer: string, request: string, files: Record<string, string>): string | undefined {
    const baseDir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
    const parts = baseDir ? baseDir.split("/") : [];
    for (const segment of request.split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment === "..") {
            parts.pop();
        } else {
            parts.push(segment);
        }
    }
    const path = parts.join("/");
    const candidates = [path, `${path}.ts`, `${path}.tsx`, `${path}.js`, `${path}.jsx`, `${path}.json`, `${path}/index.ts`, `${path}/index.js`];
    return candidates.find((candidate) => files[candidate] !== undefined);
}

/** Bare specifiers already pointing at a URL are left untouched. */
function isUrlSpecifier(path: string): boolean {
    return /^https?:\/\//.test(path) || path.startsWith("//");
}

/**
 * esbuild plugin that resolves the project's own files from an in-memory map.
 * `@babylonjs/lite` (and its subpaths) stay external so the runner iframe's import
 * map resolves the engine at run time; any *other* bare package import is rewritten
 * to an esm.sh CDN URL so external npm packages work without an import-map entry.
 */
function virtualFilesPlugin(files: Record<string, string>): esbuild.Plugin {
    return {
        name: "playground-virtual-files",
        setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
                if (args.path === LITE_SPECIFIER) {
                    return { path: args.path, external: true };
                }
                // The engine is a single module mapped only at the bare specifier in the
                // runner's import map, so subpath imports would compile but fail at run
                // time — surface that as a build error immediately.
                if (args.path.startsWith(`${LITE_SPECIFIER}/`)) {
                    return { errors: [{ text: `Subpath imports like '${args.path}' aren't supported — import everything from '${LITE_SPECIFIER}' directly.` }] };
                }
                if (args.kind === "entry-point") {
                    return { path: args.path, namespace: "virtual" };
                }
                if (args.path.startsWith(".")) {
                    const resolved = resolveRelative(args.importer, args.path, files);
                    if (!resolved) {
                        return { errors: [{ text: `Cannot resolve '${args.path}' from '${args.importer}'` }] };
                    }
                    return { path: resolved, namespace: "virtual" };
                }
                if (isUrlSpecifier(args.path)) {
                    return { path: args.path, external: true };
                }
                // Any other bare specifier loads from the esm.sh CDN at run time.
                return { path: `https://esm.sh/${args.path}`, external: true };
            });

            build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
                const contents = files[args.path];
                if (contents === undefined) {
                    return { errors: [{ text: `Missing file '${args.path}'` }] };
                }
                return { contents, loader: loaderFor(args.path) };
            });
        },
    };
}

/**
 * Bundle the user's multi-file TypeScript project to a single runnable ES module.
 *
 * Files import each other with relative specifiers (e.g. `import { make } from
 * "./scene"`); those are resolved from the in-memory `files` map and bundled.
 * `@babylonjs/lite` stays external and is resolved by the runner iframe's import
 * map at execution time. An inline source map keeps frames mapped to their
 * original file, and `//# sourceURL` keeps uncaught errors readable.
 */
export async function transpile(files: Record<string, string>, entry: string): Promise<string> {
    await ensureInitialized();
    let result: esbuild.BuildResult;
    try {
        result = await esbuild.build({
            entryPoints: [entry],
            bundle: true,
            write: false,
            format: "esm",
            target: "esnext",
            sourcemap: "inline",
            plugins: [virtualFilesPlugin(files)],
            logLevel: "silent",
        });
    } catch (err) {
        const failure = err as esbuild.BuildFailure;
        if (Array.isArray(failure?.errors) && failure.errors.length > 0) {
            throw new TranspileError(toDiagnostics(failure.errors));
        }
        throw err;
    }
    const output = result.outputFiles?.[0]?.text ?? "";
    return `${output}\n//# sourceURL=playground.js\n`;
}
