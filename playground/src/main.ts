import "./styles.css";
import { createEditor, registerEngineTypes } from "./editor";
import { transpile } from "./transpile";
import { Runner, type RunnerMessage } from "./runner";
import { EXAMPLES, DEFAULT_SNIPPET } from "./examples";
import { saveSnippet, loadSnippet, permalinkFor, snippetIdFromHash, type SnippetMeta } from "./snippets";
import { getEmbedMode, decodeCodeHash, openInPlaygroundUrl, EmbedHost } from "./embed";
import { NIGHTLY, engineUrlForVersion, fetchPublishedVersions } from "./versions";

const editorContainer = document.getElementById("editor") as HTMLElement;
const previewHost = document.getElementById("previewHost") as HTMLElement;
const consoleEl = document.getElementById("console") as HTMLElement;
const runBtn = document.getElementById("runBtn") as HTMLButtonElement;
const formatBtn = document.getElementById("formatBtn") as HTMLButtonElement;
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

// Embed mode (`?embed=runner|split`) hosts the playground inside another page and
// exposes a postMessage API. `null` when running as the standalone app.
const embedMode = getEmbedMode(location.search);
if (embedMode) {
    document.body.classList.add("embed", `embed-${embedMode}`);
}

// The id of the snippet currently loaded/saved, so re-saving creates a new
// revision of the same snippet rather than a brand-new one.
let currentSnippetId: string | null = null;
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
            appendConsole("error", message.text);
            embedHost?.emit({ channel: "babylon-lite-playground", type: "error", text: message.text });
            break;
        case "stats":
            embedHost?.emit({ channel: "babylon-lite-playground", type: "stats", fps: message.fps });
            break;
        case "ran":
            embedHost?.emit({ channel: "babylon-lite-playground", type: "ran" });
            break;
        default:
            break;
    }
});

let running = false;
let rerunPending = false;

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
    appendConsole("system", "Compiling…");
    try {
        const code = await transpile(editor.getValue());
        appendConsole("system", "Running…");
        await runner.run(code, engineUrlForVersion(currentVersion));
    } catch (err) {
        appendConsole("error", err instanceof Error ? (err.stack ?? err.message) : String(err));
    } finally {
        running = false;
        runBtn.disabled = false;
        if (rerunPending) {
            rerunPending = false;
            void run();
        }
    }
}

const editor = createEditor(editorContainer, DEFAULT_SNIPPET, () => void run());

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
        currentSnippetId = null;
        currentMeta = {};
        if (location.hash) {
            history.replaceState(null, "", location.pathname + location.search);
        }
        editor.setValue(example.code);
        void run();
    }
});

formatBtn.addEventListener("click", () => editor.format());
runBtn.addEventListener("click", () => void run());

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
        const result = await saveSnippet(editor.getValue(), meta, currentSnippetId ?? undefined);
        currentSnippetId = result.snippetId;
        currentMeta = meta;
        history.replaceState(null, "", `#${result.snippetId}`);
        const link = permalinkFor(result.snippetId);
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

async function loadFromHash(): Promise<boolean> {
    // Inline code handed off from an embed via `#code=<base64url>`.
    const inlineCode = decodeCodeHash(location.hash);
    if (inlineCode !== null) {
        currentSnippetId = null;
        currentMeta = {};
        editor.setValue(inlineCode);
        history.replaceState(null, "", location.pathname + location.search);
        return true;
    }
    const snippetId = snippetIdFromHash(location.hash);
    if (!snippetId) {
        return false;
    }
    showToast("Loading snippet…");
    try {
        const snippet = await loadSnippet(snippetId);
        currentSnippetId = snippetId;
        currentMeta = { name: snippet.name, description: snippet.description, tags: snippet.tags };
        editor.setValue(snippet.code);
        toastEl.hidden = true;
        return true;
    } catch (err) {
        showToast(err instanceof Error ? err.message : "Failed to load snippet", true);
        return false;
    }
}

// "Open in Lite Playground" hands the current content off to the full standalone
// playground (preferring a saved snippet id, falling back to inline `#code=`).
openFullBtn.addEventListener("click", (event) => {
    event.preventDefault();
    window.open(openInPlaygroundUrl(editor.getValue(), currentSnippetId), "_blank", "noopener");
});

// In embed mode, expose the postMessage API so a host page can drive the
// playground and observe its output.
if (embedMode) {
    embedHost = new EmbedHost(embedMode, {
        loadCode: (code, runAfter) => {
            currentSnippetId = null;
            currentMeta = {};
            editor.setValue(code);
            if (runAfter) {
                void run();
            }
        },
        run: () => void run(),
        dispose: () => {
            runner.dispose();
            clearConsole();
        },
        getCode: () => editor.getValue(),
    });
}

// Load engine IntelliSense in the background; editing works regardless.
void registerEngineTypes();

// Boot: load a shared snippet if the URL has one, else the default snippet.
void (async () => {
    await loadFromHash();
    void run();
    embedHost?.ready();
})();
