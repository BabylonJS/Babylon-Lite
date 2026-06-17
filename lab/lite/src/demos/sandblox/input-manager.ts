/**
 * Input Manager — the only module that touches DOM event listeners.
 *
 * Tracks raw keyboard and mouse state, exposes per-frame query methods for
 * continuous data (WASD held, mouse deltas), and emits edge-triggered semantic
 * events ("startedMoving" / "stoppedMoving") through the shared EventEmitter.
 */

import type { EventEmitter, PlayerEvents } from "./events.js";

/** Keys the demo consumes — preventDefault is called for these to avoid page scroll. */
const CONSUMED_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export class InputManager {
    private readonly _canvas: HTMLCanvasElement;
    private readonly _events: EventEmitter<PlayerEvents>;
    private readonly _keys = new Set<string>();
    private _rightDragDX = 0;
    private _rightDragDY = 0;
    private _scrollDelta = 0;
    private _rightDown = false;
    private _wasMoving = false;

    // Stored listener references for cleanup
    private readonly _onKeyDown: (e: KeyboardEvent) => void;
    private readonly _onKeyUp: (e: KeyboardEvent) => void;
    private readonly _onMouseDown: (e: MouseEvent) => void;
    private readonly _onMouseUp: (e: MouseEvent) => void;
    private readonly _onMouseMove: (e: MouseEvent) => void;
    private readonly _onWheel: (e: WheelEvent) => void;
    private readonly _onContextMenu: (e: Event) => void;
    private readonly _onBlur: () => void;

    constructor(canvas: HTMLCanvasElement, events: EventEmitter<PlayerEvents>) {
        this._canvas = canvas;
        this._events = events;

        if (canvas.tabIndex < 0) {
            canvas.tabIndex = 0;
        }

        // ── Keyboard ─────────────────────────────────────────────────────────
        this._onKeyDown = (e: KeyboardEvent): void => {
            if (CONSUMED_KEYS.has(e.code)) {
                e.preventDefault();
            }
            this._keys.add(e.code);
        };
        this._onKeyUp = (e: KeyboardEvent): void => {
            this._keys.delete(e.code);
        };

        // ── Mouse ────────────────────────────────────────────────────────────
        this._onMouseDown = (e: MouseEvent): void => {
            if (e.button === 2) {
                this._rightDown = true;
            }
        };
        this._onMouseUp = (e: MouseEvent): void => {
            if (e.button === 2) {
                this._rightDown = false;
            }
        };
        this._onMouseMove = (e: MouseEvent): void => {
            if (this._rightDown) {
                this._rightDragDX += e.movementX;
                this._rightDragDY += e.movementY;
            }
        };
        this._onWheel = (e: WheelEvent): void => {
            e.preventDefault();
            this._scrollDelta += e.deltaY;
        };

        // ── Context menu suppression ─────────────────────────────────────────
        this._onContextMenu = (e: Event): void => {
            e.preventDefault();
        };

        // ── Focus loss ───────────────────────────────────────────────────────
        this._onBlur = (): void => {
            this._keys.clear();
        };

        // ── Register ─────────────────────────────────────────────────────────
        canvas.addEventListener("keydown", this._onKeyDown);
        canvas.addEventListener("keyup", this._onKeyUp);
        canvas.addEventListener("mousedown", this._onMouseDown);
        window.addEventListener("mouseup", this._onMouseUp);
        window.addEventListener("mousemove", this._onMouseMove);
        canvas.addEventListener("wheel", this._onWheel, { passive: false });
        canvas.addEventListener("contextmenu", this._onContextMenu);
        canvas.addEventListener("blur", this._onBlur);
    }

    // ── Per-frame edge detection ─────────────────────────────────────────────

    tick(_dt: number): void {
        const isMoving = this.isMovementKeyHeld();
        if (isMoving && !this._wasMoving) {
            this._events.emit("startedMoving", undefined as void);
        }
        if (!isMoving && this._wasMoving) {
            this._events.emit("stoppedMoving", undefined as void);
        }
        this._wasMoving = isMoving;
    }

    // ── Query methods (continuous per-frame state) ───────────────────────────

    isMovementKeyHeld(): boolean {
        return this._keys.has("KeyW") || this._keys.has("KeyA") || this._keys.has("KeyS") || this._keys.has("KeyD") || this._keys.has("ArrowUp") || this._keys.has("ArrowDown");
    }

    getMovementKeys(): { w: boolean; a: boolean; s: boolean; d: boolean } {
        return {
            w: this._keys.has("KeyW") || this._keys.has("ArrowUp"),
            a: this._keys.has("KeyA"),
            s: this._keys.has("KeyS") || this._keys.has("ArrowDown"),
            d: this._keys.has("KeyD"),
        };
    }

    getMouseDeltas(): { dx: number; dy: number; scroll: number } {
        return { dx: this._rightDragDX, dy: this._rightDragDY, scroll: this._scrollDelta };
    }

    isArrowHeld(code: string): boolean {
        return this._keys.has(code);
    }

    isJumpPressed(): boolean {
        return this._keys.has("Space");
    }

    // ── Frame-end reset ──────────────────────────────────────────────────────

    resetFrameDeltas(): void {
        this._rightDragDX = 0;
        this._rightDragDY = 0;
        this._scrollDelta = 0;
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────

    dispose(): void {
        this._canvas.removeEventListener("keydown", this._onKeyDown);
        this._canvas.removeEventListener("keyup", this._onKeyUp);
        this._canvas.removeEventListener("mousedown", this._onMouseDown);
        window.removeEventListener("mouseup", this._onMouseUp);
        window.removeEventListener("mousemove", this._onMouseMove);
        this._canvas.removeEventListener("wheel", this._onWheel);
        this._canvas.removeEventListener("contextmenu", this._onContextMenu);
        this._canvas.removeEventListener("blur", this._onBlur);
        this._keys.clear();
    }
}
