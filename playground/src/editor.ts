import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
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
    getValue(): string;
    setValue(value: string): void;
    format(): void;
}

/**
 * Create the Monaco editor backed by a `file:///main.ts` model (so module
 * resolution against the registered `@babylonjs/lite` types works), with a
 * Ctrl/Cmd+Enter run shortcut.
 */
export function createEditor(container: HTMLElement, value: string, onRun: () => void): PlaygroundEditor {
    const model = monaco.editor.createModel(value, "typescript", monaco.Uri.parse("file:///main.ts"));
    const editor = monaco.editor.create(container, {
        model,
        theme: "vs-dark",
        automaticLayout: true,
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 4,
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, onRun);

    if (import.meta.env.DEV) {
        exposeDevDiagnostics(model);
    }

    return {
        getValue: () => editor.getValue(),
        setValue: (value: string) => editor.setValue(value),
        format: () => void editor.getAction("editor.action.formatDocument")?.run(),
    };
}

/**
 * Dev-only IntelliSense health probe. Exposes `window.__pgDiag()` returning the
 * TypeScript worker's semantic diagnostics for the user model and for the engine
 * declaration itself (so unresolved types inside the d.ts — e.g. WebGPU types —
 * are observable, since those never surface as editor squiggles). Stripped from
 * production builds via the `import.meta.env.DEV` guard.
 */
function exposeDevDiagnostics(model: monaco.editor.ITextModel): void {
    const probe = async (): Promise<unknown> => {
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
