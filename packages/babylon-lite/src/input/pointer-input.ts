/** Primary pointer state; read it in your frame callback, then reset its deltas. */
export interface PointerInput {
    /** Element-local CSS pixel coordinates, not drawing-buffer coordinates. */
    x: number;
    /** Element-local CSS pixel coordinate. */
    y: number;
    /** Accumulated horizontal client motion, or movementX while pointer-locked. */
    deltaX: number;
    /** Accumulated vertical client motion, or movementY while pointer-locked. */
    deltaY: number;
    /** Raw wheel deltas for the latest contiguous deltaMode batch. */
    wheelX: number;
    /** Raw wheel delta in the units identified by wheelDeltaMode. */
    wheelY: number;
    /** Raw wheel delta in the units identified by wheelDeltaMode. */
    wheelZ: number;
    /** DOM wheel units: 0 pixels, 1 lines, 2 pages. */
    wheelDeltaMode: number;
    /** DOM held-button mask: primary 1, secondary 2, auxiliary 4. */
    buttons: number;
    /** Last observed primary pointer, or null after cancellation/focus loss. */
    pointerId: number | null;
    /** Last pointer's DOM type, or empty after cancellation/focus loss. */
    pointerType: string;
    /** @internal Removes this observer's listeners and clears held/transient state. */
    _dispose?: () => void;
}

/**
 * Clear frame motion and wheel deltas, preserving position and held buttons.
 * @param input - The observer whose frame data was consumed.
 */
export function resetPointerInput(input: PointerInput): void {
    input.deltaX = input.deltaY = input.wheelX = input.wheelY = input.wheelZ = input.wheelDeltaMode = 0;
}

/**
 * Observe primary mouse, pen, or touch input without capturing or canceling events.
 * Release outside the element and iframe ownership are handled by its own window.
 * @param element - The input surface; the application owns focus and touch-action.
 * @returns Application-owned state; release with disposePointerInput.
 */
export function createPointerInput(element: HTMLElement): PointerInput {
    const doc = element.ownerDocument;
    const view = doc.defaultView;
    if (!view) {
        throw new Error("Pointer input requires a document with a window.");
    }
    const input: PointerInput = { x: 0, y: 0, deltaX: 0, deltaY: 0, wheelX: 0, wheelY: 0, wheelZ: 0, wheelDeltaMode: 0, buttons: 0, pointerId: null, pointerType: "" };
    let activeId: number | null = null;
    let lastId: number | null = null;
    let lastType = "";
    let lastX = 0;
    let lastY = 0;
    const clear = (): void => {
        activeId = lastId = input.pointerId = null;
        lastType = input.pointerType = "";
        input.buttons = 0;
        resetPointerInput(input);
    };
    const inside = (event: PointerEvent): boolean => event.composedPath().includes(element);
    const update = (event: PointerEvent, motion: boolean): void => {
        const rect = element.getBoundingClientRect();
        input.x = event.clientX - rect.left;
        input.y = event.clientY - rect.top;
        if (motion) {
            if (doc.pointerLockElement === element) {
                input.deltaX += event.movementX;
                input.deltaY += event.movementY;
            } else if (lastId === event.pointerId && lastType === event.pointerType) {
                input.deltaX += event.clientX - lastX;
                input.deltaY += event.clientY - lastY;
            }
        }
        lastId = input.pointerId = event.pointerId;
        lastType = input.pointerType = event.pointerType;
        input.buttons = event.buttons;
        lastX = event.clientX;
        lastY = event.clientY;
    };
    const down = (event: PointerEvent): void => {
        if (event.isPrimary && inside(event) && (activeId === null || activeId === event.pointerId)) {
            activeId = event.pointerId;
            update(event, false);
        }
    };
    const move = (event: PointerEvent): void => {
        if (event.isPrimary && (activeId === null ? inside(event) || doc.pointerLockElement === element : activeId === event.pointerId)) {
            update(event, true);
            // A contact can enter while already pressed, or recover from a missed release.
            activeId = event.buttons === 0 ? null : event.pointerId;
        }
    };
    const up = (event: PointerEvent): void => {
        if (activeId === event.pointerId) {
            update(event, true);
            activeId = null;
        }
    };
    const cancel = (event: PointerEvent): void => {
        if (activeId === event.pointerId) {
            clear();
        }
    };
    const wheel = (event: WheelEvent): void => {
        if (input.wheelDeltaMode !== event.deltaMode) {
            input.wheelX = input.wheelY = input.wheelZ = 0;
        }
        input.wheelDeltaMode = event.deltaMode;
        input.wheelX += event.deltaX;
        input.wheelY += event.deltaY;
        input.wheelZ += event.deltaZ;
    };
    const visibility = (): void => {
        if (doc.hidden) {
            clear();
        }
    };
    const events = [
        ["pointerdown", down],
        ["pointermove", move],
        ["pointerup", up],
        ["pointercancel", cancel],
        ["lostpointercapture", cancel],
    ] as const;
    for (const [type, handler] of events) {
        view.addEventListener(type, handler, { capture: true, passive: true });
    }
    element.addEventListener("wheel", wheel, { passive: true, capture: true });
    element.addEventListener("blur", clear);
    view.addEventListener("blur", clear);
    doc.addEventListener("visibilitychange", visibility);
    doc.addEventListener("pointerlockchange", clear);
    input._dispose = () => {
        for (const [type, handler] of events) {
            view.removeEventListener(type, handler, { capture: true });
        }
        element.removeEventListener("wheel", wheel, { capture: true });
        element.removeEventListener("blur", clear);
        view.removeEventListener("blur", clear);
        doc.removeEventListener("visibilitychange", visibility);
        doc.removeEventListener("pointerlockchange", clear);
        clear();
    };
    return input;
}

/**
 * Remove this pointer observer and clear held/transient input. Idempotent.
 * @param input - The observer to release.
 */
export function disposePointerInput(input: PointerInput): void {
    const dispose = input._dispose;
    input._dispose = undefined;
    dispose?.();
}
