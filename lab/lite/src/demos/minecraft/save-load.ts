// World save/load to a local file.
//
// Because the terrain is fully deterministic from the seed, a save is tiny: just
// the seed, the player's transform, the time-of-day, and the sparse list of player
// block edits (deltas vs. the generated terrain). Water flooding and mob/falling
// state are NOT stored — they re-derive on reload.
//
// Uses the File System Access API (showSaveFilePicker / showOpenFilePicker) when
// available, falling back to a Blob download / hidden <input type=file> for
// browsers that lack it (e.g. Firefox, Safari). No engine APIs involved.

export interface SaveData {
    v: 1;
    seed: number;
    time: number;
    player: { x: number; y: number; z: number; yaw: number; pitch: number };
    /** Flat [wx, wy, wz, id, ...] player block deltas. */
    edits: number[];
}

const SUGGESTED_NAME = "world.voxelsave.json";
const PICKER_TYPES = [{ description: "Voxel world save", accept: { "application/json": [".json"] } }];

interface SaveFilePickerWindow {
    showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
    showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle[]>;
}

function isAbort(err: unknown): boolean {
    return err instanceof DOMException && err.name === "AbortError";
}

/** Serialise + write a save. Returns true if a file was written, false if the user
 *  cancelled. Throws only on an unexpected write error. */
export async function saveToFile(data: SaveData): Promise<boolean> {
    const json = JSON.stringify(data);
    const w = window as unknown as SaveFilePickerWindow;
    if (w.showSaveFilePicker) {
        try {
            const handle = await w.showSaveFilePicker({ suggestedName: SUGGESTED_NAME, types: PICKER_TYPES });
            const stream = await handle.createWritable();
            await stream.write(json);
            await stream.close();
            return true;
        } catch (err) {
            if (isAbort(err)) return false;
            // Otherwise fall through to the download fallback.
        }
    }
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = SUGGESTED_NAME;
    a.click();
    URL.revokeObjectURL(url);
    return true;
}

/** Prompt for and parse a save file. Returns null if the user cancelled or the
 *  file was not a valid save. */
export async function loadFromFile(): Promise<SaveData | null> {
    const w = window as unknown as SaveFilePickerWindow;
    let text: string | null = null;
    if (w.showOpenFilePicker) {
        try {
            const [handle] = await w.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
            if (handle) text = await (await handle.getFile()).text();
        } catch (err) {
            if (isAbort(err)) return null;
        }
    }
    if (text === null) text = await pickViaInput();
    if (text === null) return null;
    return parseSave(text);
}

function parseSave(text: string): SaveData | null {
    try {
        const data = JSON.parse(text) as SaveData;
        if (
            data &&
            data.v === 1 &&
            typeof data.seed === "number" &&
            typeof data.time === "number" &&
            data.player &&
            typeof data.player.x === "number" &&
            Array.isArray(data.edits)
        ) {
            return data;
        }
    } catch {
        /* fall through */
    }
    return null;
}

function pickViaInput(): Promise<string | null> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) {
                resolve(null);
                return;
            }
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsText(file);
        };
        // If the dialog is dismissed without a selection, onchange never fires; that
        // simply leaves the promise pending, which is harmless for this demo.
        input.click();
    });
}
