/**
 * Persistence — the world survives page reloads .
 *
 * Thin wrapper over world-io: debounced localStorage saves of the unlocked
 * world on any mutation (plus a beforeunload flush), hydration on boot.
 * `?fresh=1` clears the save and boots the default map instead. Storage
 * failures fall back silently. Defensive loading lives in world-io.
 */

import type { Part, PartOptions } from "./part.js";
import { loadWorld, serializeWorld } from "./world-io.js";
import type { Workspace } from "./workspace.js";

const STORAGE_KEY = "sandblox-world";
const SAVE_DEBOUNCE_MS = 250;

export class Persistence {
    private readonly _workspace: Workspace<Part>;
    private readonly _createPart: (options: PartOptions) => Part;
    private _timer: ReturnType<typeof setTimeout> | null = null;
    private _started = false;

    private readonly _onPartChange = (): void => this._scheduleSave();
    private readonly _onPartAdded = (part: Part): void => {
        if (!part.locked) {
            part.onChange(this._onPartChange);
            this._scheduleSave();
        }
    };
    private readonly _onPartRemoved = (part: Part): void => {
        part.offChange(this._onPartChange);
        this._scheduleSave();
    };
    private readonly _onBeforeUnload = (): void => this._saveNow();

    constructor(workspace: Workspace<Part>, createPart: (options: PartOptions) => Part) {
        this._workspace = workspace;
        this._createPart = createPart;
    }

    /** True if the URL asks for a clean boot (`?fresh=1`). Clears the save. */
    static consumeFreshFlag(): boolean {
        try {
            if (new URLSearchParams(window.location.search).get("fresh") === "1") {
                localStorage.removeItem(STORAGE_KEY);
                return true;
            }
        } catch {
            /* storage unavailable — nothing to clear */
        }
        return false;
    }

    /** Restore the saved world. Returns false when there is no (valid) save —
     *  the caller loads the default map instead. */
    hydrate(): boolean {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return false;
            }
            return loadWorld(JSON.parse(raw), this._createPart) > 0;
        } catch {
            return false;
        }
    }

    /** Begin tracking mutations. Call AFTER hydrate/default-map load. */
    start(): void {
        if (this._started) {
            return;
        }
        this._started = true;
        for (const part of this._workspace.parts) {
            if (!part.locked) {
                part.onChange(this._onPartChange);
            }
        }
        this._workspace.on("partAdded", this._onPartAdded);
        this._workspace.on("partRemoved", this._onPartRemoved);
        window.addEventListener("beforeunload", this._onBeforeUnload);
    }

    dispose(): void {
        this._workspace.off("partAdded", this._onPartAdded);
        this._workspace.off("partRemoved", this._onPartRemoved);
        window.removeEventListener("beforeunload", this._onBeforeUnload);
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    // ── Private ──────────────────────────────────────────────────────────

    private _scheduleSave(): void {
        if (!this._started) {
            return;
        }
        if (this._timer) {
            clearTimeout(this._timer);
        }
        this._timer = setTimeout(() => {
            this._timer = null;
            this._saveNow();
        }, SAVE_DEBOUNCE_MS);
    }

    private _saveNow(): void {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeWorld(this._workspace)));
        } catch {
            /* quota/unavailable — gameplay continues unsaved */
        }
    }
}
