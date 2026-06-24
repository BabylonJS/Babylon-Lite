// Draggable divider between the editor and preview panes.
//
// The split layout is a 3-column CSS grid (`editor | splitter | preview`); the
// splitter rewrites the grid's column fractions as the user drags, and the chosen
// ratio is persisted so it survives reloads. Arrow keys nudge it for keyboard users.

const STORAGE_KEY = "bl-pg-split";
const MIN = 0.15;
const MAX = 0.85;
const STEP = 0.02;

/** Wire a splitter handle to resize the editor/preview grid and persist the ratio. */
export function mountSplitter(splitEl: HTMLElement, splitter: HTMLElement): void {
    const apply = (frac: number): number => {
        const clamped = Math.min(MAX, Math.max(MIN, frac));
        splitEl.style.gridTemplateColumns = `${clamped}fr 6px ${1 - clamped}fr`;
        return clamped;
    };
    const currentFrac = (): number => parseFloat(splitEl.style.gridTemplateColumns) || 0.5;
    const persist = (frac: number): void => localStorage.setItem(STORAGE_KEY, String(frac));

    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (stored > 0) {
        apply(stored);
    }

    let dragging = false;

    const onPointerMove = (event: PointerEvent): void => {
        if (!dragging) {
            return;
        }
        const rect = splitEl.getBoundingClientRect();
        apply((event.clientX - rect.left) / rect.width);
    };

    const onPointerUp = (event: PointerEvent): void => {
        if (!dragging) {
            return;
        }
        dragging = false;
        splitter.classList.remove("is-dragging");
        splitEl.classList.remove("is-resizing");
        splitter.releasePointerCapture?.(event.pointerId);
        persist(currentFrac());
    };

    splitter.addEventListener("pointerdown", (event) => {
        dragging = true;
        splitter.classList.add("is-dragging");
        splitEl.classList.add("is-resizing");
        splitter.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    });

    splitter.addEventListener("pointermove", onPointerMove);
    splitter.addEventListener("pointerup", onPointerUp);
    splitter.addEventListener("lostpointercapture", onPointerUp);

    splitter.addEventListener("keydown", (event) => {
        const delta = event.key === "ArrowLeft" ? -STEP : event.key === "ArrowRight" ? STEP : 0;
        if (delta === 0) {
            return;
        }
        persist(apply(currentFrac() + delta));
        event.preventDefault();
    });
}
