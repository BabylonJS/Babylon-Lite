import {
    addToScene,
    attachControl,
    createDefaultCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    loadUsd,
    registerScene,
    startEngine,
} from "babylon-lite";

interface DroppedFile {
    file: File;
    path: string;
}

function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function readEntry(entry: FileSystemEntry): Promise<DroppedFile[]> {
    if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        return [{ file, path: normalizePath(entry.fullPath || file.name) }];
    }
    if (!entry.isDirectory) {
        return [];
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) {
            break;
        }
        children.push(...batch);
    }
    return (await Promise.all(children.map(readEntry))).flat();
}

async function filesFromDrop(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
    const entries = Array.from(dataTransfer.items)
        .map((item) => item.webkitGetAsEntry())
        .filter((entry): entry is FileSystemEntry => !!entry);
    if (entries.length) {
        return (await Promise.all(entries.map(readEntry))).flat();
    }
    return Array.from(dataTransfer.files).map((file) => ({ file, path: normalizePath(file.webkitRelativePath || file.name) }));
}

function selectRoot(files: readonly DroppedFile[]): DroppedFile {
    const candidates = files.filter(({ path }) => /\.(?:usd|usda|usdc|usdz)$/i.test(path));
    if (!candidates.length) {
        throw new Error("Drop a USD, USDA, USDC, or USDZ file.");
    }
    if (candidates.length === 1) {
        return candidates[0]!;
    }
    const choices = candidates.map(({ path }, index) => `${index + 1}. ${path}`).join("\n");
    const selected = Number(prompt(`Choose the root USD layer:\n\n${choices}`, "1")) - 1;
    if (!Number.isInteger(selected) || selected < 0 || selected >= candidates.length) {
        throw new Error("No root USD layer was selected.");
    }
    return candidates[selected]!;
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const status = document.getElementById("status") as HTMLDivElement;
    const dropZone = document.getElementById("dropZone") as HTMLDivElement;
    const fileInput = document.getElementById("files") as HTMLInputElement;
    const folderInput = document.getElementById("folder") as HTMLInputElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.035, g: 0.045, b: 0.07, a: 1 };
    addToScene(scene, createHemisphericLight([0.2, 1, 0.3], 1));

    let loading = false;
    let loaded = false;
    const load = async (files: DroppedFile[]): Promise<void> => {
        if (loading || loaded || !files.length) {
            return;
        }
        loading = true;
        dropZone.classList.add("loading");
        try {
            const root = selectRoot(files);
            const sidecars: Record<string, File> = {};
            for (const item of files) {
                if (item !== root) {
                    sidecars[item.path] = item.file;
                }
            }
            status.textContent = `Loading ${root.path}...`;
            const container = await loadUsd(engine, root.file, {
                rootFileName: root.path,
                files: sidecars,
                onProgress: ({ message }) => {
                    status.textContent = message;
                },
                onLog: (level, message) => {
                    if (level === "error") {
                        console.error(message);
                    } else {
                        console.warn(message);
                    }
                },
            });
            addToScene(scene, container);
            const camera = createDefaultCamera(scene);
            attachControl(camera, canvas, scene);
            await registerScene(scene);
            await startEngine(engine);
            loaded = true;
            dropZone.classList.remove("loading");
            dropZone.classList.add("loaded");
            status.textContent = `${root.path} - ${container.diagnostics.statistics.meshes} meshes, ${container.diagnostics.statistics.instances} instances, ${container.diagnostics.statistics.triangles} triangles`;
            canvas.dataset.ready = "true";
        } catch (error) {
            dropZone.classList.remove("loading");
            status.textContent = error instanceof Error ? error.message : String(error);
            console.error(error);
        } finally {
            loading = false;
        }
    };

    window.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (!loaded) {
            dropZone.classList.add("dragging");
        }
    });
    window.addEventListener("dragleave", (event) => {
        if (!event.relatedTarget) {
            dropZone.classList.remove("dragging");
        }
    });
    window.addEventListener("drop", (event) => {
        event.preventDefault();
        dropZone.classList.remove("dragging");
        void filesFromDrop(event.dataTransfer!).then(load).catch((error) => {
            status.textContent = error instanceof Error ? error.message : String(error);
            console.error(error);
        });
    });
    fileInput.addEventListener("change", () => {
        void load(Array.from(fileInput.files ?? []).map((file) => ({ file, path: normalizePath(file.webkitRelativePath || file.name) })));
    });
    folderInput.addEventListener("change", () => {
        void load(Array.from(folderInput.files ?? []).map((file) => ({ file, path: normalizePath(file.webkitRelativePath || file.name) })));
    });
}

void main().catch((error) => {
    const status = document.getElementById("status");
    if (status) {
        status.textContent = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
