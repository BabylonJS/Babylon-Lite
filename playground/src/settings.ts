// Playground settings model: a tiny framework-agnostic store shared by the
// vanilla-TS app shell (main.ts) and the React/Fluent settings panel. Kept
// plain (no React, no engine types) so it has zero coupling in either direction.

export type EditorTheme = "vs-dark" | "hc-black";

export interface PlaygroundSettings {
    /** Show the live FPS counter over the preview. */
    showFps: boolean;
    /** Re-run the scene automatically a short delay after edits stop. */
    autoRun: boolean;
    /** Debounce (ms) before an auto-run fires. */
    autoRunDelay: number;
    /** Monaco editor font size in pixels. */
    editorFontSize: number;
    /** Soft-wrap long lines in the editor. */
    wordWrap: boolean;
    /** Show the Monaco minimap. */
    minimap: boolean;
    /** Monaco color theme. */
    editorTheme: EditorTheme;
}

export const DEFAULT_SETTINGS: PlaygroundSettings = {
    showFps: true,
    autoRun: false,
    autoRunDelay: 800,
    editorFontSize: 13,
    wordWrap: false,
    minimap: false,
    editorTheme: "vs-dark",
};

const STORAGE_KEY = "babylon-lite-playground:settings";

export interface SettingsStore {
    get(): PlaygroundSettings;
    /** Merge a partial update, persist it, and notify subscribers. */
    set(patch: Partial<PlaygroundSettings>): void;
    /** Restore every setting to its default. */
    reset(): void;
    /** Subscribe to changes; returns an unsubscribe function. */
    subscribe(listener: (settings: PlaygroundSettings) => void): () => void;
}

function load(): PlaygroundSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return { ...DEFAULT_SETTINGS };
        }
        const parsed = JSON.parse(raw) as Partial<PlaygroundSettings>;
        // Merge over defaults so a stored blob from an older version (missing
        // keys) still yields a fully-populated, valid settings object.
        return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function createSettingsStore(): SettingsStore {
    let current = load();
    const listeners = new Set<(settings: PlaygroundSettings) => void>();

    const persist = (): void => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
        } catch {
            // Ignore quota / privacy-mode failures — settings just won't persist.
        }
    };

    const emit = (): void => {
        for (const listener of listeners) {
            listener(current);
        }
    };

    return {
        get: () => current,
        set: (patch) => {
            current = { ...current, ...patch };
            persist();
            emit();
        },
        reset: () => {
            current = { ...DEFAULT_SETTINGS };
            persist();
            emit();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
