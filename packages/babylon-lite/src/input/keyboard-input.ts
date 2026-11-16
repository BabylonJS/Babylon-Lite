/** Held physical keyboard keys, owned by one application input observer. */
export interface KeyboardInput {
    /** Physical KeyboardEvent.code values, such as KeyW and ShiftLeft. */
    readonly keys: ReadonlySet<string>;
    /** @internal Removes this observer's listeners and clears held keys. */
    _dispose?: () => void;
}

/**
 * Observe keys on a focusable element or a window, independently of camera controls.
 * Does not focus the target, prevent defaults, or install frame callbacks.
 * @param target - The element or window receiving keyboard input.
 * @returns Application-owned held-key state; release with disposeKeyboardInput.
 */
export function createKeyboardInput(target: HTMLElement | Window): KeyboardInput {
    const doc = "ownerDocument" in target ? target.ownerDocument : target.document;
    const view = doc.defaultView;
    if (!view) {
        throw new Error("Keyboard input requires a document with a window.");
    }
    const keys = new Set<string>();
    const input: KeyboardInput = { keys };
    const clear = (): void => keys.clear();
    const down = (event: Event): void => {
        const code = (event as KeyboardEvent).code;
        if (code) {
            keys.add(code);
        }
    };
    const up = (event: KeyboardEvent): void => {
        keys.delete(event.code);
    };
    const visibility = (): void => {
        if (doc.hidden) {
            clear();
        }
    };
    target.addEventListener("keydown", down, true);
    target.addEventListener("blur", clear, true);
    view.addEventListener("keyup", up, true);
    view.addEventListener("blur", clear);
    doc.addEventListener("visibilitychange", visibility);
    input._dispose = () => {
        target.removeEventListener("keydown", down, { capture: true });
        target.removeEventListener("blur", clear, { capture: true });
        view.removeEventListener("keyup", up, { capture: true });
        view.removeEventListener("blur", clear);
        doc.removeEventListener("visibilitychange", visibility);
        clear();
    };
    return input;
}

/**
 * Read one physical key's held state.
 * @param input - The state returned by createKeyboardInput.
 * @param code - A KeyboardEvent.code value, independent of keyboard layout.
 * @returns Whether the key is currently held.
 */
export function isKeyboardKeyDown(input: KeyboardInput, code: string): boolean {
    return input.keys.has(code);
}

/**
 * Remove this keyboard observer and clear its keys. Safe to call repeatedly.
 * @param input - The observer to release.
 */
export function disposeKeyboardInput(input: KeyboardInput): void {
    const dispose = input._dispose;
    input._dispose = undefined;
    dispose?.();
}
