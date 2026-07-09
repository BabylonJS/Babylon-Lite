import "./styles.css";
import { createEditor, registerEngineTypes } from "./editor";
import { mountFileTabs } from "./file-tabs";
import { mountSplitter } from "./split";
import { transpile, TranspileError } from "./transpile";
import { downloadProject } from "./download";
import { Runner, type RunnerMessage } from "./runner";
import { EXAMPLES, DEFAULT_PROJECT, STARTER_PROJECT, projectFor } from "./examples";
import {
    saveSnippet,
    loadSnippet,
    permalinkFor,
    snippetPath,
    parseSnippetPath,
    snippetIdFromHash,
    splitSnippetId,
    combineSnippetId,
    type SnippetMeta,
    type Project,
} from "./snippets";
import { getEmbedMode, decodeCodeHash, openInPlaygroundUrl, EmbedHost } from "./embed";
import { NIGHTLY, engineUrlForVersion, fetchPublishedVersions } from "./versions";
import { createSettingsStore, type PlaygroundSettings } from "./settings";
import { mountSettingsPanel } from "./fluent/settings-panel";
import { mountAppChrome } from "./fluent/app-chrome";
import { mountToolbar, type ToolbarModel, type ToolbarActions, type ViewMode } from "./fluent/toolbar";

const editorContainer = document.getElementById("editor") as HTMLElement;
const fileTabsContainer = document.getElementById("fileTabs") as HTMLElement;
const previewHost = document.getElementById("previewHost") as HTMLElement;
const previewLoader = document.getElementById("previewLoader") as HTMLElement;
const previewLoaderText = document.getElementById("previewLoaderText") as HTMLElement;
const consoleEl = document.getElementById("console") as HTMLElement;
const splitEl = document.getElementById("split") as HTMLElement;
const splitter = document.getElementById("splitter") as HTMLElement;
const fullscreenBtn = document.getElementById("fullscreenBtn") as HTMLButtonElement;
const fpsCounter = document.getElementById("fpsCounter") as HTMLElement;
const settingsDrawer = document.getElementById("settingsDrawer") as HTMLElement;
const settingsBackdrop = document.getElementById("settingsBackdrop") as HTMLElement;
const settingsRoot = document.getElementById("settingsRoot") as HTMLElement;

// Shared playground settings, persisted to localStorage. Drives editor options,
// the FPS overlay, and auto-run; the Fluent settings panel reads/writes the same store.
const settings = createSettingsStore();

// The Fluent app-chrome island (toast + save dialog). main.ts drives it imperatively.
const chrome = mountAppChrome(document.getElementById("appChromeRoot") as HTMLElement);

// Embed mode (`?embed=runner|split`) hosts the playground inside another page and
// exposes a postMessage API. `null` when running as the standalone app.
const embedMode = getEmbedMode(location.search);
if (embedMode) {
    document.body.classList.add("embed", `embed-${embedMode}`);
}

// The id + revision of the snippet currently loaded/saved, so re-saving creates a
// new revision of the same snippet and the URL reflects `/snippet/ID/v/VERSION`.
let currentSnippetId: string | null = null;
let currentSnippetVersion = "0";
let currentMeta: SnippetMeta = {};

// Host bridge, only created in embed mode (see below).
let embedHost: EmbedHost | null = null;

// The engine version the runner loads (`"nightly"` self-hosted by default, or a
// published version from the CDN).
let currentVersion = NIGHTLY;

function appendConsole(level: string, text: string): void {
    const line = document.createElement("div");
    line.className = `line level-${level}`;
    line.textContent = text;
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clearConsole(): void {
    consoleEl.replaceChildren();
}

/** Show/hide the preview loading screen, optionally updating its label. */
function setLoading(on: boolean, label?: string): void {
    previewLoader.hidden = !on;
    if (label) {
        previewLoaderText.textContent = label;
    }
}

/** Human-readable byte size, e.g. `48.2 KB`. */
function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Human-readable duration, e.g. `820 ms` or `1.24 s`. */
function formatDuration(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Append a clickable build error that jumps the editor to the offending location. */
function appendBuildError(file: string, line: number, column: number, text: string): void {
    const lineEl = document.createElement("div");
    lineEl.className = "line level-error clickable";
    const where = file ? `${file}:${line}:${column}` : `:${line}:${column}`;
    lineEl.textContent = `${where} — ${text}`;
    lineEl.title = "Jump to error";
    lineEl.addEventListener("click", () => editor.revealLocation(file, line, column));
    consoleEl.appendChild(lineEl);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

function showToast(text: string, isError = false): void {
    chrome.showToast(text, isError);
}

const runner = new Runner(previewHost, (message: RunnerMessage) => {
    switch (message.type) {
        case "console":
            appendConsole(message.level, message.text);
            embedHost?.emit({ channel: "babylon-lite-playground", type: "console", level: message.level, text: message.text });
            break;
        case "error":
            setLoading(false);
            runStartedAt = null;
            appendConsole("error", message.text);
            embedHost?.emit({ channel: "babylon-lite-playground", type: "error", text: message.text });
            break;
        case "stats":
            if (settings.get().showFps) {
                fpsCounter.hidden = false;
                fpsCounter.textContent = `${Math.round(message.fps)} FPS`;
            }
            embedHost?.emit({ channel: "babylon-lite-playground", type: "stats", fps: message.fps });
            break;
        case "ran":
            setLoading(false);
            if (runStartedAt !== null) {
                appendConsole("system", `Scene ready in ${formatDuration(performance.now() - runStartedAt)}`);
                runStartedAt = null;
            }
            embedHost?.emit({ channel: "babylon-lite-playground", type: "ran" });
            break;
        default:
            break;
    }
});

let running = false;
let rerunPending = false;
// When the transpiled module was handed to the runner, so we can report how long
// the scene took to become ready (the runner posts `ran` once it finishes).
let runStartedAt: number | null = null;

async function run(): Promise<void> {
    // Coalesce concurrent requests: remember that another run was asked for and
    // replay it once with the latest editor content when the current one settles.
    if (running) {
        rerunPending = true;
        return;
    }
    running = true;
    toolbar.update({ running: true });
    clearConsole();
    setLoading(true, "Compiling…");
    appendConsole("system", "Compiling…");
    try {
        const compileStart = performance.now();
        const code = await transpile(editor.getFiles(), editor.getEntry());
        const compileMs = performance.now() - compileStart;
        const size = new Blob([code]).size;
        editor.clearBuildMarkers();
        appendConsole("system", `Compiled ${formatBytes(size)} in ${formatDuration(compileMs)}`);
        setLoading(true, "Running…");
        appendConsole("system", "Running…");
        runStartedAt = performance.now();
        await runner.run(code, await engineUrlForVersion(currentVersion));
    } catch (err) {
        setLoading(false);
        runStartedAt = null;
        if (err instanceof TranspileError) {
            editor.setBuildMarkers(err.diagnostics);
            for (const diag of err.diagnostics) {
                appendBuildError(diag.file, diag.line, diag.column, diag.message);
            }
        } else {
            editor.clearBuildMarkers();
            appendConsole("error", err instanceof Error ? (err.stack ?? err.message) : String(err));
        }
    } finally {
        running = false;
        toolbar.update({ running: false });
        if (rerunPending) {
            rerunPending = false;
            void run();
        }
    }
}

const editor = createEditor(editorContainer, DEFAULT_PROJECT.files, DEFAULT_PROJECT.entry, () => void run());
mountFileTabs(fileTabsContainer, editor);
// The runner-only embed hides the editor, so there's nothing to resize there.
if (embedMode !== "runner") {
    mountSplitter(splitEl, splitter);
}

// --- Playground settings: apply to the editor / FPS overlay, wire auto-run ----

/** Push the current settings into the editor and preview chrome. */
function applySettings(next: PlaygroundSettings): void {
    editor.updateOptions({
        fontSize: next.editorFontSize,
        wordWrap: next.wordWrap ? "on" : "off",
        minimap: { enabled: next.minimap },
    });
    editor.setTheme(next.editorTheme);
    // Hide the FPS overlay immediately when disabled; it reappears on the next
    // stats tick when re-enabled.
    if (!next.showFps) {
        fpsCounter.hidden = true;
    }
}

applySettings(settings.get());
settings.subscribe(applySettings);

// Auto-run: re-run a short debounce after edits stop, when enabled in settings.
let autoRunTimer: number | undefined;
editor.onContentChange(() => {
    const current = settings.get();
    if (!current.autoRun) {
        return;
    }
    window.clearTimeout(autoRunTimer);
    autoRunTimer = window.setTimeout(() => void run(), current.autoRunDelay);
});

// Settings drawer: a lazily-mounted Fluent/React island (see fluent/settings-panel).
// The gear button lives in the Fluent toolbar and calls openSettings via actions.
let settingsPanelMounted = false;
let settingsOpen = false;

function closeSettings(): void {
    if (!settingsOpen) {
        return;
    }
    settingsOpen = false;
    settingsDrawer.hidden = true;
    settingsBackdrop.hidden = true;
}

function openSettings(): void {
    if (settingsOpen) {
        return;
    }
    settingsOpen = true;
    if (!settingsPanelMounted) {
        mountSettingsPanel(settingsRoot, settings, closeSettings);
        settingsPanelMounted = true;
    }
    settingsBackdrop.hidden = false;
    settingsDrawer.hidden = false;
    // Slide in: start off-screen, then release on the next frame.
    settingsDrawer.classList.add("is-entering");
    requestAnimationFrame(() => settingsDrawer.classList.remove("is-entering"));
}

settingsBackdrop.addEventListener("click", closeSettings);
window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && settingsOpen) {
        closeSettings();
    }
});

/** Current editor content as a saveable project. */
function currentProject(): Project {
    return { files: editor.getFiles(), entry: editor.getEntry() };
}

/** Forget any loaded snippet and reset the URL to the app root. */
function resetToUnsaved(): void {
    currentSnippetId = null;
    currentSnippetVersion = "0";
    currentMeta = {};
    if (location.hash || location.pathname !== "/") {
        history.replaceState(null, "", "/");
    }
}

// --- Local autosave + unsaved-changes guard ---------------------------------
// Edits are debounced to localStorage so an accidental reload/close doesn't lose
// work, and `beforeunload` warns while there are unsaved edits (standalone only).

const AUTOSAVE_KEY = "bl-pg-autosave";

interface Autosave {
    files: Record<string, string>;
    entry: string;
    snippetId: string | null;
    version: string;
    meta: SnippetMeta;
}

let dirty = false;
let autosaveTimer: number | undefined;

function writeAutosave(): void {
    const payload: Autosave = { ...currentProject(), snippetId: currentSnippetId, version: currentSnippetVersion, meta: currentMeta };
    try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
    } catch {
        // Storage may be unavailable (private mode / quota); autosave is best-effort.
    }
}

function clearAutosave(): void {
    window.clearTimeout(autosaveTimer);
    try {
        localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
        // ignore
    }
}

function readAutosave(): Autosave | null {
    try {
        const raw = localStorage.getItem(AUTOSAVE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw) as Partial<Autosave>;
        if (parsed && parsed.files && typeof parsed.files === "object" && typeof parsed.entry === "string") {
            return { files: parsed.files, entry: parsed.entry, snippetId: parsed.snippetId ?? null, version: parsed.version ?? "0", meta: parsed.meta ?? {} };
        }
    } catch {
        // Corrupt payload — ignore.
    }
    return null;
}

/** Mark the project as having unsaved edits (drives autosave + the unload guard). */
function markDirty(): void {
    dirty = true;
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(writeAutosave, 800);
}

/** Mark the project clean (after save / load / new) and drop the autosave snapshot. */
function markClean(): void {
    dirty = false;
    clearAutosave();
}

editor.onContentChange(markDirty);

if (!embedMode) {
    window.addEventListener("beforeunload", (event) => {
        if (dirty) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
}

// --- Toolbar (Fluent) --------------------------------------------------------
// The header is a Fluent React island (fluent/toolbar.tsx). All behaviour still
// lives here; the toolbar renders the model and forwards user intent through the
// actions below.

const MODE_KEY = "bl-pg-mode";

const EXAMPLE_OPTIONS = EXAMPLES.map((example) => ({ value: example.id, label: example.label }));

// Restore the persisted view mode (storage may be unavailable / throw — fall back to scene).
let storedMode: string | null = null;
try {
    storedMode = localStorage.getItem(MODE_KEY);
} catch {
    // Storage blocked (private mode / third-party iframe); use the default.
}
const initialMode: ViewMode = storedMode === "code" ? "code" : "scene";

const toolbarActions: ToolbarActions = {
    run: () => void run(),
    newProject,
    save: () => void save(currentMeta),
    saveWithDetails: () => {
        chrome.openSaveDialog({ name: currentMeta.name ?? "", description: currentMeta.description ?? "", tags: currentMeta.tags ?? "" }, (values) => void save(values));
    },
    download: downloadCurrent,
    openInFull,
    openSettings,
    setMode,
    setVersion,
    loadExample,
};

const initialToolbarModel: ToolbarModel = {
    mode: initialMode,
    version: currentVersion,
    versions: [{ value: NIGHTLY, label: "Nightly (latest source)" }],
    examples: EXAMPLE_OPTIONS,
    selectedExample: null,
    running: false,
    embedMode,
};

const toolbar = mountToolbar(document.getElementById("toolbarRoot") as HTMLElement, toolbarActions, initialToolbarModel);

// Apply the initial view mode now that the toolbar is mounted (body classes drive
// the responsive CSS; the toolbar reflects the selected tab).
setMode(initialMode);

/** Toggle the Code/Scene view (drives the responsive CSS via <body> classes). */
function setMode(mode: ViewMode): void {
    document.body.classList.toggle("mode-code", mode === "code");
    document.body.classList.toggle("mode-scene", mode === "scene");
    toolbar.update({ mode });
    try {
        localStorage.setItem(MODE_KEY, mode);
    } catch {
        // Best-effort persistence; ignore storage failures.
    }
}

/** Load one of the bundled examples as a fresh, unsaved project. */
function loadExample(id: string): void {
    const example = EXAMPLES.find((candidate) => candidate.id === id);
    if (!example) {
        return;
    }
    resetToUnsaved();
    editor.setFiles(projectFor(example).files, projectFor(example).entry);
    toolbar.update({ selectedExample: id });
    markClean();
    void run();
}

/** Discard the current project (guarded if dirty) and load a clean starter scene. */
function newProject(): void {
    if (dirty && !window.confirm("Discard unsaved changes and start a new project?")) {
        return;
    }
    resetToUnsaved();
    editor.setFiles(STARTER_PROJECT.files, STARTER_PROJECT.entry);
    toolbar.update({ selectedExample: null });
    markClean();
    void run();
}

/** Switch the engine version the runner loads, and re-run. */
function setVersion(version: string): void {
    currentVersion = version;
    toolbar.update({ version });
    void run();
}

let downloading = false;
/** Package the current project as a runnable zip. */
function downloadCurrent(): void {
    if (downloading) {
        return;
    }
    downloading = true;
    chrome.showProgress("Packaging download…");
    void downloadProject(currentProject(), currentVersion, currentMeta.name ?? "")
        .then(() => chrome.dismissToast())
        .catch((err: unknown) => showToast(err instanceof Error ? err.message : "Failed to build download", true))
        .finally(() => {
            downloading = false;
        });
}

/** Hand the current content off to the full standalone Lite Playground. */
function openInFull(): void {
    const snippet = currentSnippetId ? { id: currentSnippetId, version: currentSnippetVersion } : null;
    window.open(openInPlaygroundUrl(JSON.stringify(currentProject()), snippet), "_blank", "noopener");
}

// Fullscreen the preview canvas (toggles in/out).
fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
        void document.exitFullscreen();
    } else {
        void previewHost.requestFullscreen?.();
    }
});

// Populate the engine version list: "Nightly" plus published releases (from the CDN).
void (async () => {
    const versions = await fetchPublishedVersions();
    toolbar.update({
        versions: [{ value: NIGHTLY, label: "Nightly (latest source)" }, ...versions.map((version) => ({ value: version, label: `v${version}` }))],
    });
})();

let saving = false;
async function save(meta: SnippetMeta): Promise<void> {
    if (saving) {
        return;
    }
    saving = true;
    chrome.showProgress("Saving…");
    try {
        const result = await saveSnippet(currentProject(), meta, currentSnippetId ?? undefined);
        currentSnippetId = result.id;
        currentSnippetVersion = result.version;
        currentMeta = meta;
        markClean();
        // Push (not replace) so the previous URL stays on the history stack and
        // the browser back button returns to it — e.g. the earlier snippet version.
        history.pushState(null, "", snippetPath(result.id, result.version));
        const link = permalinkFor(result.id, result.version);
        try {
            await navigator.clipboard.writeText(link);
            showToast("Link copied to clipboard");
        } catch {
            showToast(`Saved — ${link}`);
        }
    } catch (err) {
        showToast(err instanceof Error ? err.message : "Failed to save snippet", true);
    } finally {
        saving = false;
    }
}

async function loadFromUrl(): Promise<boolean> {
    // Inline content handed off from an embed via `#code=<base64url>`. The fragment
    // carries either a project JSON (`{files,entry}`) or, for legacy links, raw source.
    const inline = decodeCodeHash(location.hash);
    if (inline !== null) {
        currentSnippetId = null;
        currentSnippetVersion = "0";
        currentMeta = {};
        const project = parseProject(inline);
        editor.setFiles(project.files, project.entry);
        markClean();
        history.replaceState(null, "", "/");
        return true;
    }
    // Path form `/snippet/ID/v/VERSION` (canonical) — load and keep the URL.
    const fromPath = parseSnippetPath(location.pathname);
    if (fromPath) {
        return loadSnippetInto(fromPath.id, fromPath.version, false);
    }
    // Legacy hash form `#ID[#REV]` — load, then rewrite to the path form.
    const hashId = snippetIdFromHash(location.hash);
    if (hashId) {
        const { id, version } = splitSnippetId(hashId);
        return loadSnippetInto(id, version, true);
    }
    return false;
}

/** Load a snippet revision into the editor, optionally rewriting the URL to the path form. */
async function loadSnippetInto(id: string, version: string, rewriteUrl: boolean): Promise<boolean> {
    chrome.showProgress("Loading snippet…");
    try {
        const snippet = await loadSnippet(combineSnippetId(id, version));
        currentSnippetId = id;
        currentSnippetVersion = version;
        currentMeta = { name: snippet.name, description: snippet.description, tags: snippet.tags };
        editor.setFiles(snippet.files, snippet.entry);
        markClean();
        if (rewriteUrl) {
            history.replaceState(null, "", snippetPath(id, version));
        }
        chrome.dismissToast();
        return true;
    } catch (err) {
        showToast(err instanceof Error ? err.message : "Failed to load snippet", true);
        return false;
    }
}

/** Interpret a `#code=` payload as a project, falling back to a single entry file. */
function parseProject(payload: string): Project {
    try {
        const parsed = JSON.parse(payload) as Partial<Project>;
        if (parsed && parsed.files && typeof parsed.files === "object" && parsed.entry) {
            return { files: parsed.files, entry: parsed.entry };
        }
    } catch {
        // Not JSON — treat as plain single-file source.
    }
    return { files: { "index.ts": payload }, entry: "index.ts" };
}

// In embed mode, expose the postMessage API so a host page can drive the
// playground and observe its output.
if (embedMode) {
    embedHost = new EmbedHost(embedMode, {
        loadCode: (code, runAfter) => {
            currentSnippetId = null;
            currentSnippetVersion = "0";
            currentMeta = {};
            // The embed API is single-file: replace just the entry file's content.
            const files = editor.getFiles();
            files[editor.getEntry()] = code;
            editor.setFiles(files, editor.getEntry());
            if (runAfter) {
                void run();
            }
        },
        run: () => void run(),
        dispose: () => {
            runner.dispose();
            clearConsole();
        },
        getCode: () => editor.getFiles()[editor.getEntry()] ?? "",
    });
}

// Load engine IntelliSense in the background; editing works regardless.
void registerEngineTypes();

// Browser back/forward: reflect the target URL. Because save() pushes a history
// entry, navigating back can land on an earlier snippet version — reload it and
// re-run. Landing at a non-snippet URL (e.g. the root) just drops the snippet
// association so the current content behaves as unsaved again.
if (!embedMode) {
    window.addEventListener("popstate", () => {
        void (async () => {
            const fromPath = parseSnippetPath(location.pathname);
            if (fromPath) {
                if (await loadSnippetInto(fromPath.id, fromPath.version, false)) {
                    void run();
                } else {
                    // Load failed: the browser already moved the address bar to the
                    // target path, but state still reflects the previously loaded
                    // snippet. Restore the URL so URL and state stay in sync.
                    history.replaceState(null, "", currentSnippetId ? snippetPath(currentSnippetId, currentSnippetVersion) : "/");
                }
                return;
            }
            currentSnippetId = null;
            currentSnippetVersion = "0";
            currentMeta = {};
        })();
    });
}

// Boot: load a shared snippet if the URL has one, else restore autosaved work,
// else fall back to the default snippet already in the editor.
void (async () => {
    const loadedFromUrl = await loadFromUrl();
    if (!loadedFromUrl && !embedMode) {
        const saved = readAutosave();
        if (saved) {
            currentSnippetId = saved.snippetId;
            currentSnippetVersion = saved.version;
            currentMeta = saved.meta;
            editor.setFiles(saved.files, saved.entry);
            toolbar.update({ selectedExample: null });
            if (saved.snippetId) {
                history.replaceState(null, "", snippetPath(saved.snippetId, saved.version));
            }
            dirty = true;
            showToast("Restored unsaved work");
        }
    }
    void run();
    embedHost?.ready();
})();
