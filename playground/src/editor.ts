import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import type { BuildDiagnostic } from "./transpile";
// The WebGPU type definitions are bundled as raw text so Monaco can resolve the
// ~90 `GPU*` types referenced by the engine's public surface (otherwise the engine
// d.ts itself reports "cannot find name" errors). They declare global interfaces.
import webgpuTypes from "@webgpu/types/dist/index.d.ts?raw";

// Wire Monaco's web workers through Vite's `?worker` imports.
self.MonacoEnvironment = {
    getWorker(_workerId, label) {
        if (label === "typescript" || label === "javascript") {
            return new tsWorker();
        }
        return new editorWorker();
    },
};

const ts = monaco.languages.typescript.typescriptDefaults;

ts.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    strict: true,
    allowNonTsExtensions: true,
    noEmit: true,
    lib: ["esnext", "dom", "dom.iterable"],
});

// WebGPU globals — added as an ambient lib so `GPUDevice`, `GPUColorDict`, etc.
// resolve everywhere, including inside the engine d.ts below.
ts.addExtraLib(webgpuTypes, "file:///node_modules/@webgpu/types/index.d.ts");

let engineTypesLoaded = false;

/**
 * Register the rolled-up engine declaration as the ambient `@babylonjs/lite`
 * module so snippet imports get full IntelliSense (completions, hovers, signatures).
 *
 * The d.ts is fetched from the same self-hosted location the runner imports the
 * engine bundle from (`/engine/dev/`), so the types always match the running
 * engine. A `package.json` stub makes Node-style resolution map the bare
 * `@babylonjs/lite` specifier to the declaration file.
 */
export async function registerEngineTypes(): Promise<void> {
    if (engineTypesLoaded) {
        return;
    }
    engineTypesLoaded = true;
    try {
        const response = await fetch("/engine/dev/index.d.ts");
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const dts = await response.text();
        ts.addExtraLib(dts, "file:///node_modules/@babylonjs/lite/index.d.ts");
        ts.addExtraLib(JSON.stringify({ name: "@babylonjs/lite", version: "0.0.0", types: "index.d.ts" }), "file:///node_modules/@babylonjs/lite/package.json");
    } catch (err) {
        engineTypesLoaded = false;
        // Non-fatal: the editor still works, just without engine IntelliSense.
        console.warn("[playground] failed to load @babylonjs/lite types:", err);
    }
}

export interface PlaygroundEditor {
    /** Replace the entire project: dispose existing models, create one per file. */
    setFiles(files: Record<string, string>, entry: string): void;
    /** Snapshot of every file's current content, keyed by filename. */
    getFiles(): Record<string, string>;
    /** Filenames in tab order. */
    getFileNames(): string[];
    /** The entry file that the runner bundles from. */
    getEntry(): string;
    setEntry(name: string): void;
    /** The file currently shown in the editor. */
    getActive(): string;
    setActive(name: string): void;
    addFile(name: string, content?: string): void;
    renameFile(oldName: string, newName: string): void;
    removeFile(name: string): void;
    format(): void;
    /** Subscribe to file-set / active-file changes (for the tab bar). */
    onChange(listener: () => void): void;
    /** Subscribe to edits to any file's content (for autosave / dirty tracking). */
    onContentChange(listener: () => void): void;
    /** Show build errors as editor markers (red squiggles + Problems entries). */
    setBuildMarkers(diagnostics: BuildDiagnostic[]): void;
    /** Clear any build-error markers (e.g. after a successful run). */
    clearBuildMarkers(): void;
    /** Focus a file and move the cursor to a 1-based line/column. */
    revealLocation(file: string, line: number, column: number): void;
}

function languageForFile(name: string): string {
    return name.endsWith(".js") || name.endsWith(".jsx") ? "javascript" : "typescript";
}

/**
 * Create the multi-file Monaco editor. Each file is backed by its own model under
 * a `file:///<name>` URI so TypeScript resolves both the ambient `@babylonjs/lite`
 * module and relative imports between the project's own files. A single editor view
 * swaps between models as the active file changes, with a Ctrl/Cmd+Enter run shortcut.
 */
export function createEditor(container: HTMLElement, files: Record<string, string>, entry: string, onRun: () => void): PlaygroundEditor {
    const models = new Map<string, monaco.editor.ITextModel>();
    const order: string[] = [];
    let activeName = entry;
    let entryName = entry;
    const listeners: Array<() => void> = [];

    const editor = monaco.editor.create(container, {
        theme: "vs-dark",
        automaticLayout: true,
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 4,
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, onRun);

    const contentListeners: Array<() => void> = [];

    const emit = (): void => listeners.forEach((listener) => listener());
    editor.onDidChangeModelContent(() => contentListeners.forEach((listener) => listener()));

    const BUILD_MARKER_OWNER = "playground-build";

    function clearBuildMarkers(): void {
        for (const model of models.values()) {
            monaco.editor.setModelMarkers(model, BUILD_MARKER_OWNER, []);
        }
    }

    function setBuildMarkers(diagnostics: BuildDiagnostic[]): void {
        const byFile = new Map<string, monaco.editor.IMarkerData[]>();
        for (const diag of diagnostics) {
            const list = byFile.get(diag.file) ?? [];
            list.push({
                severity: monaco.MarkerSeverity.Error,
                message: diag.message,
                startLineNumber: diag.line,
                startColumn: diag.column,
                endLineNumber: diag.line,
                endColumn: diag.column + Math.max(1, diag.length),
            });
            byFile.set(diag.file, list);
        }
        clearBuildMarkers();
        for (const [file, markers] of byFile) {
            const model = models.get(file);
            if (model) {
                monaco.editor.setModelMarkers(model, BUILD_MARKER_OWNER, markers);
            }
        }
    }

    function revealLocation(file: string, line: number, column: number): void {
        if (models.has(file)) {
            setActive(file);
        }
        const position = { lineNumber: line, column };
        editor.setPosition(position);
        editor.revealPositionInCenter(position);
        editor.focus();
    }

    function modelUri(name: string): monaco.Uri {
        return monaco.Uri.parse(`file:///${name}`);
    }

    function createModel(name: string, content: string): monaco.editor.ITextModel {
        // Reuse a stale model at the same URI if Monaco hasn't disposed it yet.
        const existing = monaco.editor.getModel(modelUri(name));
        existing?.dispose();
        const model = monaco.editor.createModel(content, languageForFile(name), modelUri(name));
        models.set(name, model);
        return model;
    }

    function disposeAll(): void {
        for (const model of models.values()) {
            model.dispose();
        }
        models.clear();
        order.length = 0;
    }

    function setActive(name: string): void {
        const model = models.get(name);
        if (!model) {
            return;
        }
        activeName = name;
        editor.setModel(model);
        emit();
    }

    function setFiles(next: Record<string, string>, nextEntry: string): void {
        disposeAll();
        const names = Object.keys(next);
        for (const name of names) {
            createModel(name, next[name] ?? "");
            order.push(name);
        }
        entryName = next[nextEntry] !== undefined ? nextEntry : (names[0] ?? "index.ts");
        if (!models.has(entryName)) {
            // Guarantee at least one file exists.
            createModel(entryName, "");
            order.push(entryName);
        }
        setActive(entryName);
    }

    function uniqueName(name: string): string {
        if (!models.has(name)) {
            return name;
        }
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        let index = 2;
        while (models.has(`${stem}${index}${ext}`)) {
            index++;
        }
        return `${stem}${index}${ext}`;
    }

    function addFile(name: string, content = ""): void {
        const finalName = uniqueName(name);
        createModel(finalName, content);
        order.push(finalName);
        setActive(finalName);
    }

    function renameFile(oldName: string, rawNew: string): void {
        const newName = rawNew.trim();
        const model = models.get(oldName);
        if (!model || !newName || newName === oldName || models.has(newName)) {
            return;
        }
        // Models are immutable in their URI, so re-create under the new name.
        const content = model.getValue();
        model.dispose();
        models.delete(oldName);
        createModel(newName, content);
        order[order.indexOf(oldName)] = newName;
        if (entryName === oldName) {
            entryName = newName;
        }
        if (activeName === oldName) {
            setActive(newName);
        } else {
            emit();
        }
    }

    function removeFile(name: string): void {
        if (models.size <= 1 || !models.has(name)) {
            return;
        }
        models.get(name)?.dispose();
        models.delete(name);
        order.splice(order.indexOf(name), 1);
        if (entryName === name) {
            entryName = order[0]!;
        }
        if (activeName === name) {
            setActive(order[0]!);
        } else {
            emit();
        }
    }

    setFiles(files, entry);

    if (import.meta.env.DEV) {
        exposeDevDiagnostics(() => models.get(entryName));
    }

    return {
        setFiles,
        getFiles: () => Object.fromEntries(order.map((name) => [name, models.get(name)!.getValue()])),
        getFileNames: () => [...order],
        getEntry: () => entryName,
        setEntry: (name: string) => {
            if (models.has(name)) {
                entryName = name;
                emit();
            }
        },
        getActive: () => activeName,
        setActive,
        addFile,
        renameFile,
        removeFile,
        format: () => void editor.getAction("editor.action.formatDocument")?.run(),
        onChange: (listener: () => void) => listeners.push(listener),
        onContentChange: (listener: () => void) => contentListeners.push(listener),
        setBuildMarkers,
        clearBuildMarkers,
        revealLocation,
    };
}

/**
 * Dev-only IntelliSense health probe. Exposes `window.__pgDiag()` returning the
 * TypeScript worker's semantic diagnostics for the entry model and for the engine
 * declaration itself (so unresolved types inside the d.ts — e.g. WebGPU types —
 * are observable, since those never surface as editor squiggles). Stripped from
 * production builds via the `import.meta.env.DEV` guard.
 */
function exposeDevDiagnostics(getModel: () => monaco.editor.ITextModel | undefined): void {
    const probe = async (): Promise<unknown> => {
        const model = getModel();
        if (!model) {
            return { error: "no entry model" };
        }
        const worker = await monaco.languages.typescript.getTypeScriptWorker();
        const client = await worker(model.uri);
        const engineDtsUri = "file:///node_modules/@babylonjs/lite/index.d.ts";
        const [mainSemantic, mainSyntactic, engineSemantic] = await Promise.all([
            client.getSemanticDiagnostics(model.uri.toString()),
            client.getSyntacticDiagnostics(model.uri.toString()),
            client.getSemanticDiagnostics(engineDtsUri),
        ]);
        return {
            main: { semantic: mainSemantic.length, syntactic: mainSyntactic.length, messages: mainSemantic.map((d) => d.messageText) },
            engineDts: { semantic: engineSemantic.length, messages: engineSemantic.slice(0, 10).map((d) => d.messageText) },
        };
    };
    (window as unknown as { __pgDiag?: typeof probe }).__pgDiag = probe;
}
