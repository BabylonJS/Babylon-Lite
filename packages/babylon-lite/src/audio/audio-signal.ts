/**
 * Lightweight event signal — Babylon Lite's tree-shakable replacement for the
 * core `Observable`. Pure state + standalone-ish callback set. No module-level
 * side effects: the callback set is created lazily on first `add`.
 *
 * Behavioural parity with the subset of `Observable` the audio engine uses:
 * `add`, `addOnce`, `removeCallback`, `notifyObservers`, `clear`, `hasObservers`.
 */

/** Public read surface of a signal — consumers can only subscribe. */
export interface AudioSignal<T> {
    /** Subscribe. Returns an unsubscribe function. */
    add(callback: (value: T) => void): () => void;
    /** Subscribe for a single notification. Returns an unsubscribe function. */
    addOnce(callback: (value: T) => void): () => void;
}

/** Full read/write signal — held internally by the engine/sounds. @internal */
export interface AudioSignalImpl<T> extends AudioSignal<T> {
    /** @internal */ _removeCallback(callback: (value: T) => void): void;
    /** @internal */ _notify(value: T): void;
    /** @internal */ _clear(): void;
    /** @internal */ _hasObservers(): boolean;
}

interface Entry<T> {
    cb: (value: T) => void;
    once: boolean;
}

/** Create a new signal. No allocation happens until the first subscriber. @internal */
export function createAudioSignal<T>(): AudioSignalImpl<T> {
    let entries: Entry<T>[] | null = null;

    const remove = (callback: (value: T) => void): void => {
        if (!entries) {
            return;
        }
        const i = entries.findIndex((e) => e.cb === callback);
        if (i !== -1) {
            entries.splice(i, 1);
        }
    };

    return {
        add(callback) {
            (entries ??= []).push({ cb: callback, once: false });
            return () => remove(callback);
        },
        addOnce(callback) {
            (entries ??= []).push({ cb: callback, once: true });
            return () => remove(callback);
        },
        _removeCallback(callback) {
            remove(callback);
        },
        _notify(value) {
            if (!entries || entries.length === 0) {
                return;
            }
            // Snapshot so callbacks may add/remove during iteration.
            const snapshot = entries.slice();
            for (const entry of snapshot) {
                if (entry.once) {
                    remove(entry.cb);
                }
                entry.cb(value);
            }
        },
        _clear() {
            entries = null;
        },
        _hasObservers() {
            return !!entries && entries.length > 0;
        },
    };
}
