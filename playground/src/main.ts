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

const editorContainer = document.getElementById("editor") as HTMLElement;
const fileTabsContainer = document.getElementById("fileTabs") as HTMLElement;
const previewHost = document.getElementById("previewHost") as HTMLElement;
const previewLoader = document.getElementById("previewLoader") as HTMLElement;
const previewLoaderText = document.getElementById("previewLoaderText") as HTMLElement;
const consoleEl = document.getElementById("console") as HTMLElement;
const splitEl = document.getElementById("split") as HTMLElement;
const splitter = document.getElementById("splitter") as HTMLElement;
const runBtn = document.getElementById("runBtn") as HTMLButtonElement;
const newBtn = document.getElementById("newBtn") as HTMLButtonElement;
const fullscreenBtn = document.getElementById("fullscreenBtn") as HTMLButtonElement;
const fpsCounter = document.getElementById("fpsCounter") as HTMLElement;
const downloadBtn = document.getElementById("downloadBtn") as HTMLButtonElement;
const examplesEl = document.getElementById("examples") as HTMLSelectElement;
const versionEl = document.getElementById("versionSelect") as HTMLSelectElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const saveDetailsBtn = document.getElementById("saveDetailsBtn") as HTMLButtonElement;
const saveDialog = document.getElementById("saveDialog") as HTMLDialogElement;
const saveDialogCancel = document.getElementById("saveDialogCancel") as HTMLButtonElement;
const snippetNameInput = document.getElementById("snippetName") as HTMLInputElement;
const snippetDescriptionInput = document.getElementById("snippetDescription") as HTMLTextAreaElement;
const snippetTagsInput = document.getElementById("snippetTags") as HTMLInputElement;
const toastEl = document.getElementById("toast") as HTMLElement;
const openFullBtn = document.getElementById("openFullBtn") as HTMLAnchorElement;
const menuBtn = document.getElementById("menuBtn") as HTMLButtonElement;
const actionsMenu = document.getElementById("actionsMenu") as HTMLElement;
const modeCodeBtn = document.getElementById("modeCodeBtn") as HTMLButtonElement;
const modeSceneBtn = document.getElementById("modeSceneBtn") as HTMLButtonElement;

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

let toastTimer: number | undefined;
function showToast(text: string, isError = false): void {
    toastEl.textContent = text;
    toastEl.classList.toggle("error", isError);
    toastEl.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        toastEl.hidden = true;
    }, 3000);
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
            fpsCounter.hidden = false;
            fpsCounter.textContent = `${Math.round(message.fps)} FPS`;
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
    runBtn.disabled = true;
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
        await runner.run(code, engineUrlForVersion(currentVersion));
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
        runBtn.disabled = false;
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

// Populate the examples picker.
for (const example of EXAMPLES) {
    const option = document.createElement("option");
    option.value = example.id;
    option.textContent = example.label;
    examplesEl.appendChild(option);
}

examplesEl.addEventListener("change", () => {
    const example = EXAMPLES.find((candidate) => candidate.id === examplesEl.value);
    if (example) {
        // Loading an example starts a fresh, unsaved snippet.
        resetToUnsaved();
        editor.setFiles(projectFor(example).files, projectFor(example).entry);
        markClean();
        void run();
    }
});

runBtn.addEventListener("click", () => void run());

// --- Mobile chrome: hamburger menu + Code/Scene view toggle ------------------
// On narrow screens the toolbar actions collapse into a dropdown, and the
// side-by-side split becomes a single pane that switches between editing the
// code and viewing the scene. Both are driven by classes on <body>; the CSS
// media query decides whether they have any visual effect.

const MODE_KEY = "bl-pg-mode";

function closeMenu(): void {
    document.body.classList.remove("menu-open");
    menuBtn.setAttribute("aria-expanded", "false");
}

function toggleMenu(): void {
    const open = document.body.classList.toggle("menu-open");
    menuBtn.setAttribute("aria-expanded", String(open));
}

menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu();
});

// Close the menu after picking an action, or when tapping outside it.
actionsMenu.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".btn, a")) {
        closeMenu();
    }
});
actionsMenu.addEventListener("change", closeMenu);
document.addEventListener("click", (event) => {
    if (document.body.classList.contains("menu-open") && !(event.target as HTMLElement).closest(".toolbar")) {
        closeMenu();
    }
});

// The two mode tabs, in DOM order, for roving-tabindex keyboard navigation.
const modeTabs = [modeCodeBtn, modeSceneBtn];

function setMode(mode: "code" | "scene"): void {
    document.body.classList.toggle("mode-code", mode === "code");
    document.body.classList.toggle("mode-scene", mode === "scene");
    // ARIA tab semantics: the selected tab is the single roving tab stop; the
    // other is removed from the tab order and reached via arrow keys.
    for (const tab of modeTabs) {
        const isActive = (tab === modeCodeBtn) === (mode === "code");
        tab.setAttribute("aria-selected", String(isActive));
        tab.tabIndex = isActive ? 0 : -1;
    }
    try {
        localStorage.setItem(MODE_KEY, mode);
    } catch {
        // Best-effort persistence; ignore storage failures.
    }
}

modeCodeBtn.addEventListener("click", () => setMode("code"));
modeSceneBtn.addEventListener("click", () => setMode("scene"));

// Arrow/Home/End move selection between the tabs (WAI-ARIA tabs pattern).
function onModeKeydown(event: KeyboardEvent): void {
    const index = modeTabs.indexOf(event.currentTarget as HTMLButtonElement);
    let next: number;
    switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
            next = (index + 1) % modeTabs.length;
            break;
        case "ArrowLeft":
        case "ArrowUp":
            next = (index - 1 + modeTabs.length) % modeTabs.length;
            break;
        case "Home":
            next = 0;
            break;
        case "End":
            next = modeTabs.length - 1;
            break;
        default:
            return;
    }
    event.preventDefault();
    setMode(next === 0 ? "code" : "scene");
    modeTabs[next]?.focus();
}

for (const tab of modeTabs) {
    tab.addEventListener("keydown", onModeKeydown);
}

// Restore the persisted mode (storage may be unavailable / throw — fall back to scene).
let storedMode: string | null = null;
try {
    storedMode = localStorage.getItem(MODE_KEY);
} catch {
    // Storage blocked (private mode / third-party iframe); use the default.
}
setMode(storedMode === "code" ? "code" : "scene");

// New: discard the current project (with a guard if there are unsaved edits) and
// load a clean starter scene.
newBtn.addEventListener("click", () => {
    if (dirty && !window.confirm("Discard unsaved changes and start a new project?")) {
        return;
    }
    resetToUnsaved();
    editor.setFiles(STARTER_PROJECT.files, STARTER_PROJECT.entry);
    examplesEl.selectedIndex = -1;
    markClean();
    void run();
});

// Fullscreen the preview canvas (toggles in/out).
fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
        void document.exitFullscreen();
    } else {
        void previewHost.requestFullscreen?.();
    }
});

downloadBtn.addEventListener("click", () => {
    downloadBtn.disabled = true;
    showToast("Packaging download…");
    void downloadProject(currentProject(), currentVersion, currentMeta.name ?? "")
        .then(() => {
            toastEl.hidden = true;
        })
        .catch((err: unknown) => showToast(err instanceof Error ? err.message : "Failed to build download", true))
        .finally(() => {
            downloadBtn.disabled = false;
        });
});

// Engine version selector: "Nightly" plus published releases (loaded from the CDN).
function addVersionOption(value: string, label: string): void {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    versionEl.appendChild(option);
}
addVersionOption(NIGHTLY, "Nightly (latest source)");
versionEl.value = NIGHTLY;

versionEl.addEventListener("change", () => {
    currentVersion = versionEl.value;
    void run();
});

void (async () => {
    const versions = await fetchPublishedVersions();
    for (const version of versions) {
        addVersionOption(version, `v${version}`);
    }
    // Keep the current selection (defaults to nightly) after populating.
    versionEl.value = currentVersion;
})();

async function save(meta: SnippetMeta): Promise<void> {
    saveBtn.disabled = true;
    saveDetailsBtn.disabled = true;
    showToast("Saving…");
    try {
        const result = await saveSnippet(currentProject(), meta, currentSnippetId ?? undefined);
        currentSnippetId = result.id;
        currentSnippetVersion = result.version;
        currentMeta = meta;
        markClean();
        history.replaceState(null, "", snippetPath(result.id, result.version));
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
        saveBtn.disabled = false;
        saveDetailsBtn.disabled = false;
    }
}

saveBtn.addEventListener("click", () => void save(currentMeta));

saveDetailsBtn.addEventListener("click", () => {
    snippetNameInput.value = currentMeta.name ?? "";
    snippetDescriptionInput.value = currentMeta.description ?? "";
    snippetTagsInput.value = currentMeta.tags ?? "";
    saveDialog.showModal();
});

saveDialogCancel.addEventListener("click", () => saveDialog.close());

saveDialog.addEventListener("submit", () => {
    void save({
        name: snippetNameInput.value.trim(),
        description: snippetDescriptionInput.value.trim(),
        tags: snippetTagsInput.value.trim(),
    });
});

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
    showToast("Loading snippet…");
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
        toastEl.hidden = true;
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

// "Open in Lite Playground" hands the current content off to the full standalone
// playground (preferring a saved snippet id, falling back to inline `#code=`).
openFullBtn.addEventListener("click", (event) => {
    event.preventDefault();
    const snippet = currentSnippetId ? { id: currentSnippetId, version: currentSnippetVersion } : null;
    window.open(openInPlaygroundUrl(JSON.stringify(currentProject()), snippet), "_blank", "noopener");
});

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
            examplesEl.selectedIndex = -1;
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
