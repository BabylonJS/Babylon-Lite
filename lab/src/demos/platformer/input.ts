/**
 * Input for the platformer demo: keyboard + on-screen touch buttons unified into a
 * single polled `InputState`. The engine provides no input subsystem (it is a pure
 * renderer), so this is hand-rolled with DOM listeners — explicitly allowed for the
 * demos, which exist to showcase the renderer.
 */

export interface InputState {
    left: boolean;
    right: boolean;
    down: boolean;
    /** True while a jump control is held (for variable jump height). */
    jumpHeld: boolean;
    /** True for exactly one poll after a fresh jump press (edge), then auto-cleared. */
    jumpPressed: boolean;
    run: boolean;
    /** Edge-triggered: set once when the player presses a "start / restart" key. */
    startPressed: boolean;
}

export interface InputController {
    readonly state: InputState;
    /** Consume edge flags (jumpPressed/startPressed). Call once per game tick after reading. */
    endFrame: () => void;
    dispose: () => void;
}

const LEFT_KEYS = new Set(["ArrowLeft", "KeyA"]);
const RIGHT_KEYS = new Set(["ArrowRight", "KeyD"]);
const DOWN_KEYS = new Set(["ArrowDown", "KeyS"]);
const JUMP_KEYS = new Set(["Space", "KeyZ", "ArrowUp", "KeyW", "KeyK"]);
const RUN_KEYS = new Set(["ShiftLeft", "ShiftRight", "KeyX", "KeyJ"]);
const START_KEYS = new Set(["Enter", "KeyR"]);

/**
 * Build the input controller. `touchHost` (when supplied) receives the on-screen
 * D-pad + buttons for touch devices.
 */
export function createInput(touchHost?: HTMLElement): InputController {
    const state: InputState = {
        left: false,
        right: false,
        down: false,
        jumpHeld: false,
        jumpPressed: false,
        run: false,
        startPressed: false,
    };

    const onKey = (down: boolean) => (ev: KeyboardEvent): void => {
        const c = ev.code;
        let handled = true;
        if (LEFT_KEYS.has(c)) state.left = down;
        else if (RIGHT_KEYS.has(c)) state.right = down;
        else if (DOWN_KEYS.has(c)) state.down = down;
        else if (JUMP_KEYS.has(c)) {
            if (down && !state.jumpHeld) state.jumpPressed = true;
            state.jumpHeld = down;
        } else if (RUN_KEYS.has(c)) state.run = down;
        else if (START_KEYS.has(c)) {
            if (down) state.startPressed = true;
        } else handled = false;
        if (handled) ev.preventDefault();
    };

    const onDown = onKey(true);
    const onUp = onKey(false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);

    const touchCleanup: Array<() => void> = [];
    if (touchHost) {
        buildTouchControls(touchHost, state, touchCleanup);
    }

    return {
        state,
        endFrame(): void {
            state.jumpPressed = false;
            state.startPressed = false;
        },
        dispose(): void {
            window.removeEventListener("keydown", onDown);
            window.removeEventListener("keyup", onUp);
            for (const fn of touchCleanup) fn();
        },
    };
}

function buildTouchControls(host: HTMLElement, state: InputState, cleanup: Array<() => void>): void {
    const wrap = document.createElement("div");
    wrap.style.cssText =
        "position:absolute;inset:auto 0 0 0;display:flex;justify-content:space-between;align-items:flex-end;" +
        "padding:18px 20px;pointer-events:none;user-select:none;touch-action:none;z-index:30;";

    const makeBtn = (label: string, set: (v: boolean) => void): HTMLElement => {
        const b = document.createElement("div");
        b.textContent = label;
        b.style.cssText =
            "pointer-events:auto;width:64px;height:64px;margin:6px;border-radius:14px;display:flex;" +
            "align-items:center;justify-content:center;font:700 26px system-ui,sans-serif;color:#fff;" +
            "background:rgba(20,20,40,.45);border:2px solid rgba(255,255,255,.35);backdrop-filter:blur(2px);";
        const press = (v: boolean) => (ev: Event): void => {
            ev.preventDefault();
            set(v);
            b.style.background = v ? "rgba(80,140,255,.6)" : "rgba(20,20,40,.45)";
        };
        const d = press(true);
        const u = press(false);
        b.addEventListener("touchstart", d, { passive: false });
        b.addEventListener("touchend", u, { passive: false });
        b.addEventListener("touchcancel", u, { passive: false });
        b.addEventListener("mousedown", d);
        b.addEventListener("mouseup", u);
        b.addEventListener("mouseleave", u);
        cleanup.push(() => {
            b.removeEventListener("touchstart", d);
            b.removeEventListener("touchend", u);
            b.removeEventListener("touchcancel", u);
        });
        return b;
    };

    const dpad = document.createElement("div");
    dpad.style.cssText = "display:flex;pointer-events:none;";
    dpad.appendChild(makeBtn("\u25C0", (v) => (state.left = v)));
    dpad.appendChild(makeBtn("\u25B6", (v) => (state.right = v)));

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;pointer-events:none;";
    actions.appendChild(
        makeBtn("\u25BC", (v) => (state.down = v)),
    );
    actions.appendChild(
        makeBtn("B", (v) => (state.run = v)),
    );
    actions.appendChild(
        makeBtn("A", (v) => {
            if (v && !state.jumpHeld) state.jumpPressed = true;
            state.jumpHeld = v;
        }),
    );

    wrap.appendChild(dpad);
    wrap.appendChild(actions);
    host.appendChild(wrap);
    cleanup.push(() => wrap.remove());
}
