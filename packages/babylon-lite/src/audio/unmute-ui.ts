/**
 * Unmute UI — opt-in feature module.
 *
 * Faithful port of AudioV2 `_WebAudioUnmuteUI`, re-architected to Lite idioms
 * (pure state + standalone functions). Adds a DOM button that resumes the
 * audio context when pressed, shown only while the engine is not running.
 * Pulls the DOM/CSS payload only when {@link createUnmuteUI} is called.
 *
 * Adaptation: the default parent is `document.body` (Lite's audio is decoupled
 * from the renderer, so there is no `EngineStore.LastCreatedEngine` canvas to
 * anchor to). Pass {@link UnmuteUIOptions.parentElement} to override.
 */

import { type AudioEngine, unlockAudioEngineAsync } from "./audio-engine.js";

/** Options for {@link createUnmuteUI}. */
export interface UnmuteUIOptions {
    /** Parent element for the button. Defaults to `document.body`. */
    parentElement?: HTMLElement;
}

/** Unmute UI handle. Pure state — driven by the unmute-UI functions. */
export interface UnmuteUI {
    /** @internal */ _engine: AudioEngine;
    /** @internal */ _button: HTMLButtonElement | null;
    /** @internal */ _style: HTMLStyleElement | null;
    /** @internal */ _enabled: boolean;
    /** @internal */ _unsub: (() => void) | null;
    /** @internal */ _dispose(): void;
}

function buildCss(top: number): string {
    return `.babylonUnmute{position:absolute;top:${top}px;margin-left:20px;height:40px;width:60px;background-color:rgba(51,51,51,0.7);background-image:url("data:image/svg+xml;charset=UTF-8,%3Csvg%20version%3D%221.1%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2239%22%20height%3D%2232%22%20viewBox%3D%220%200%2039%2032%22%3E%3Cpath%20fill%3D%22white%22%20d%3D%22M9.625%2018.938l-0.031%200.016h-4.953q-0.016%200-0.031-0.016v-12.453q0-0.016%200.031-0.016h4.953q0.031%200%200.031%200.016v12.453zM12.125%207.688l8.719-8.703v27.453l-8.719-8.719-0.016-0.047v-9.938zM23.359%207.875l1.406-1.406%204.219%204.203%204.203-4.203%201.422%201.406-4.219%204.219%204.219%204.203-1.484%201.359-4.141-4.156-4.219%204.219-1.406-1.422%204.219-4.203z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E");background-size:80%;background-repeat:no-repeat;background-position:center;background-position-y:4px;border:none;outline:none;transition:transform 0.125s ease-out;cursor:pointer;z-index:9999;}.babylonUnmute:hover{transform:scale(1.05)}`;
}

function showButton(ui: UnmuteUI): void {
    if (!ui._button || !ui._enabled) {
        return;
    }
    ui._button.style.display = "block";
}

function hideButton(ui: UnmuteUI): void {
    if (ui._button) {
        ui._button.style.display = "none";
    }
}

/**
 * Creates and mounts the unmute button. It is shown while the engine's context
 * is not `"running"` and hidden once it resumes; clicking it unlocks the engine.
 * @param engine - The audio engine to unlock.
 * @param options - UI options (parent element).
 * @returns The UI handle; dispose it with {@link disposeUnmuteUI}.
 */
export function createUnmuteUI(engine: AudioEngine, options: UnmuteUIOptions = {}): UnmuteUI {
    const parent = options.parentElement ?? document.body;
    const top = (parent.offsetTop || 0) + 20;

    const style = document.createElement("style");
    style.appendChild(document.createTextNode(buildCss(top)));
    document.head.appendChild(style);

    const button = document.createElement("button");
    button.className = "babylonUnmute";
    button.id = "babylonUnmuteButton";
    button.addEventListener("click", () => {
        void unlockAudioEngineAsync(engine);
    });
    parent.appendChild(button);

    const ui: UnmuteUI = {
        _engine: engine,
        _button: button,
        _style: style,
        _enabled: true,
        _unsub: null,
        _dispose: () => disposeUnmuteUI(ui),
    };

    ui._unsub = engine.onStateChanged.add(() => {
        if (engine.state === "running") {
            hideButton(ui);
        } else {
            showButton(ui);
        }
    });

    // Reflect the initial state.
    if (engine.state === "running") {
        hideButton(ui);
    } else {
        showButton(ui);
    }

    return ui;
}

/**
 * Enables or disables the unmute button. When disabled it is hidden; when
 * enabled it is shown if the engine is not running.
 * @param ui - The UI handle.
 * @param enabled - Whether the button may be shown.
 */
export function setUnmuteUIEnabled(ui: UnmuteUI, enabled: boolean): void {
    ui._enabled = enabled;
    if (enabled) {
        if (ui._engine.state !== "running") {
            showButton(ui);
        }
    } else {
        hideButton(ui);
    }
}

/**
 * Removes the unmute button and its styles and unsubscribes from engine state.
 * @param ui - The UI handle.
 */
export function disposeUnmuteUI(ui: UnmuteUI): void {
    ui._button?.remove();
    ui._button = null;
    ui._style?.remove();
    ui._style = null;
    ui._unsub?.();
    ui._unsub = null;
}
