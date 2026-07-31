/**
 * Racer input — keyboard and on-screen touch controls unified into the two
 * analog axes consumed by the vehicle controller.
 *
 * Maps WASD / arrow keys and four touch buttons to the Godot kit's
 * `Input.get_axis` actions:
 *   • steer    — A/← = -1 (left)      D/→ = +1 (right)
 *   • throttle — S/↓ = -1 (reverse)   W/↑ = +1 (forward)
 */

/** Continuous per-frame control axes, each in the range [-1, 1]. */
export interface RacerAxes {
    steer: number;
    throttle: number;
}

const CONSUMED: readonly string[] = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"];

interface TouchState {
    left: boolean;
    right: boolean;
    forward: boolean;
    back: boolean;
}

export class RacerInput {
    private readonly _keys = new Set<string>();
    private readonly _touch: TouchState = { left: false, right: false, forward: false, back: false };
    private readonly _touchCleanup: Array<() => void> = [];
    private readonly _touchReset: Array<() => void> = [];
    private readonly _touchRoot: HTMLDivElement;
    private readonly _canvas: HTMLCanvasElement;
    private readonly _onKeyDown: (e: KeyboardEvent) => void;
    private readonly _onKeyUp: (e: KeyboardEvent) => void;
    private readonly _onBlur: () => void;

    constructor(canvas: HTMLCanvasElement) {
        this._canvas = canvas;
        if (canvas.tabIndex < 0) {
            canvas.tabIndex = 0;
        }

        this._onKeyDown = (e: KeyboardEvent): void => {
            if (CONSUMED.includes(e.code)) {
                e.preventDefault();
            }
            this._keys.add(e.code);
        };
        this._onKeyUp = (e: KeyboardEvent): void => {
            this._keys.delete(e.code);
        };
        this._onBlur = (): void => {
            this._keys.clear();
            for (const reset of this._touchReset) {
                reset();
            }
        };

        canvas.addEventListener("blur", this._onBlur);
        window.addEventListener("keydown", this._onKeyDown);
        window.addEventListener("keyup", this._onKeyUp);
        window.addEventListener("blur", this._onBlur);
        this._touchRoot = this._buildTouchControls();
    }

    /** Read the current control axes. */
    read(): RacerAxes {
        const k = this._keys;
        const left = k.has("KeyA") || k.has("ArrowLeft");
        const right = k.has("KeyD") || k.has("ArrowRight");
        const forward = k.has("KeyW") || k.has("ArrowUp");
        const back = k.has("KeyS") || k.has("ArrowDown");
        return {
            steer: (right || this._touch.right ? 1 : 0) - (left || this._touch.left ? 1 : 0),
            throttle: (forward || this._touch.forward ? 1 : 0) - (back || this._touch.back ? 1 : 0),
        };
    }

    dispose(): void {
        this._canvas.removeEventListener("blur", this._onBlur);
        window.removeEventListener("keydown", this._onKeyDown);
        window.removeEventListener("keyup", this._onKeyUp);
        window.removeEventListener("blur", this._onBlur);
        for (const cleanup of this._touchCleanup) {
            cleanup();
        }
        for (const reset of this._touchReset) {
            reset();
        }
        this._touchRoot.remove();
        this._keys.clear();
    }

    private _buildTouchControls(): HTMLDivElement {
        const root = document.createElement("div");
        root.className = "racer-touch-controls";
        root.setAttribute("aria-label", "Touch driving controls");

        const makeButton = (symbol: string, label: string, key: keyof TouchState): HTMLButtonElement => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "racer-touch-button";
            button.textContent = symbol;
            button.setAttribute("aria-label", label);
            button.setAttribute("aria-pressed", "false");

            // Pointer capture guarantees release reaches the original button even
            // when a finger slides away. Tracking ids also keeps multi-touch chords
            // (for example accelerate + steer) independent and prevents stuck input.
            const activePointers = new Set<number>();
            const setActive = (active: boolean): void => {
                this._touch[key] = active;
                button.classList.toggle("is-active", active);
                button.setAttribute("aria-pressed", String(active));
            };
            const reset = (): void => {
                activePointers.clear();
                setActive(false);
            };
            const down = (event: PointerEvent): void => {
                event.preventDefault();
                activePointers.add(event.pointerId);
                setActive(true);
                try {
                    button.setPointerCapture(event.pointerId);
                } catch {
                    // Capture is best-effort; the cancel and blur paths still clear input.
                }
            };
            const up = (event: PointerEvent): void => {
                if (activePointers.delete(event.pointerId) && activePointers.size === 0) {
                    setActive(false);
                }
            };
            const preventMenu = (event: Event): void => event.preventDefault();
            button.addEventListener("pointerdown", down);
            button.addEventListener("pointerup", up);
            button.addEventListener("pointercancel", up);
            button.addEventListener("lostpointercapture", up);
            button.addEventListener("contextmenu", preventMenu);
            this._touchReset.push(reset);
            this._touchCleanup.push(() => {
                button.removeEventListener("pointerdown", down);
                button.removeEventListener("pointerup", up);
                button.removeEventListener("pointercancel", up);
                button.removeEventListener("lostpointercapture", up);
                button.removeEventListener("contextmenu", preventMenu);
            });
            return button;
        };

        const steering = document.createElement("div");
        steering.className = "racer-touch-cluster";
        steering.append(makeButton("◀", "Steer left", "left"), makeButton("▶", "Steer right", "right"));

        const pedals = document.createElement("div");
        pedals.className = "racer-touch-cluster";
        pedals.append(makeButton("▼", "Brake or reverse", "back"), makeButton("▲", "Accelerate", "forward"));

        root.append(steering, pedals);
        document.body.appendChild(root);
        return root;
    }
}
