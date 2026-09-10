import type { ArcRotateCamera } from "./arc-rotate.js";
import { _installArcRotateKeyboardControls } from "./arc-rotate-controls.js";

/** Keyboard direction mappings, matched against {@link KeyboardEvent.code}. */
export interface ArcRotateKeyboardMappings {
    /** Rotate or pan left. Default: `["ArrowLeft"]`. */
    left?: readonly string[];
    /** Rotate or pan right. Default: `["ArrowRight"]`. */
    right?: readonly string[];
    /** Rotate up, pan up, or zoom in. Default: `["ArrowUp"]`. */
    up?: readonly string[];
    /** Rotate down, pan down, or zoom out. Default: `["ArrowDown"]`. */
    down?: readonly string[];
}

/** Configuration for opt-in arc-rotate keyboard controls. */
export interface ArcRotateKeyboardOptions {
    /** Direction mappings. Omitted fields retain their Arrow-key defaults. */
    keys?: ArcRotateKeyboardMappings;
    /** Rotation divisor; higher values rotate more slowly. Default: `100`. */
    angularSensitivity?: number;
    /** Panning divisor; higher values pan more slowly. Default: `50`. */
    panningSensitivity?: number;
    /** Zooming divisor; higher values zoom more slowly. Default: `25`. */
    zoomingSensitivity?: number;
}

function hasHeldKey(keys: Set<string>, mapping: readonly string[] | undefined, fallback: string): boolean {
    if (!mapping) {
        return keys.has(fallback);
    }
    for (let i = 0; i < mapping.length; i++) {
        if (keys.has(mapping[i]!)) {
            return true;
        }
    }
    return false;
}

function attachKeyboardControls(
    camera: ArcRotateCamera,
    canvas: HTMLCanvasElement,
    keyboard: boolean | ArcRotateKeyboardOptions | undefined
): readonly [applyInput: () => void, dispose: () => void] | undefined {
    if (!keyboard) {
        return undefined;
    }

    const options = typeof keyboard === "object" ? keyboard : undefined;
    const mappings = options?.keys;
    const angularSensitivity = options?.angularSensitivity ?? 100;
    const panningSensitivity = options?.panningSensitivity ?? 50;
    const zoomingSensitivity = options?.zoomingSensitivity ?? 25;
    const heldKeys = new Set<string>();
    let ctrlKey = false;
    let altKey = false;
    let metaKey = false;

    function matchesMapping(code: string, mapping: readonly string[] | undefined, fallback: string): boolean {
        return mapping ? mapping.includes(code) : code === fallback;
    }

    function isDirection(code: string): boolean {
        return (
            matchesMapping(code, mappings?.left, "ArrowLeft") ||
            matchesMapping(code, mappings?.right, "ArrowRight") ||
            matchesMapping(code, mappings?.up, "ArrowUp") ||
            matchesMapping(code, mappings?.down, "ArrowDown")
        );
    }

    function updateModifiers(e: KeyboardEvent): void {
        ctrlKey = e.ctrlKey;
        altKey = e.altKey;
        metaKey = e.metaKey;
    }

    function onKeyDown(e: KeyboardEvent): void {
        updateModifiers(e);
        if (!e.metaKey && isDirection(e.code)) {
            heldKeys.add(e.code);
            e.preventDefault();
        }
    }

    function onKeyUp(e: KeyboardEvent): void {
        updateModifiers(e);
        heldKeys.delete(e.code);
        if (!e.metaKey && isDirection(e.code)) {
            e.preventDefault();
        }
    }

    function clearState(): void {
        heldKeys.clear();
        ctrlKey = false;
        altKey = false;
        metaKey = false;
    }

    function applyInput(): void {
        if (metaKey) {
            return;
        }

        const left = hasHeldKey(heldKeys, mappings?.left, "ArrowLeft");
        const right = hasHeldKey(heldKeys, mappings?.right, "ArrowRight");
        const up = hasHeldKey(heldKeys, mappings?.up, "ArrowUp");
        const down = hasHeldKey(heldKeys, mappings?.down, "ArrowDown");
        const horizontal = (right ? 1 : 0) - (left ? 1 : 0);

        if (ctrlKey) {
            const vertical = (up ? 1 : 0) - (down ? 1 : 0);
            const magnitude = Math.hypot(horizontal, vertical);
            if (magnitude !== 0) {
                camera.inertialPanningX += horizontal / magnitude / panningSensitivity;
                camera.inertialPanningY += vertical / magnitude / panningSensitivity;
            }
            return;
        }

        if (altKey) {
            camera.inertialAlphaOffset += horizontal / angularSensitivity;
            camera.inertialRadiusOffset += ((up ? 1 : 0) - (down ? 1 : 0)) / zoomingSensitivity;
            return;
        }

        const vertical = (down ? 1 : 0) - (up ? 1 : 0);
        const magnitude = Math.hypot(horizontal, vertical);
        if (magnitude !== 0) {
            camera.inertialAlphaOffset += horizontal / magnitude / angularSensitivity;
            camera.inertialBetaOffset += vertical / magnitude / angularSensitivity;
        }
    }

    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("keyup", onKeyUp);
    canvas.addEventListener("blur", clearState);
    if (!canvas.hasAttribute("tabindex")) {
        canvas.tabIndex = 0;
    }

    return [
        applyInput,
        () => {
            canvas.removeEventListener("keydown", onKeyDown);
            canvas.removeEventListener("keyup", onKeyUp);
            canvas.removeEventListener("blur", clearState);
            clearState();
        },
    ];
}

/**
 * Install arc-rotate keyboard input support. Process-global and idempotent.
 *
 * Call once before passing `keyboard` to {@link attachControl}. Keeping this
 * explicit lets pointer-only bundles remove all keyboard state and handlers.
 */
export function enableArcRotateKeyboardControls(): void {
    _installArcRotateKeyboardControls(attachKeyboardControls);
}
