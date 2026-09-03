import type { GpuPicker, Mesh, PointerDrag, PositionGizmo, UtilityLayer } from "babylon-lite";
import { createGpuPicker, disposePicker, isGizmoDragging, isGizmoPickPending, pickAsync, registerPointerDrag } from "babylon-lite";

interface PointerCanvasProxy {
    readonly canvas: HTMLCanvasElement;
    emit(type: string, event: PointerEvent): void;
}

function createPointerCanvasProxy(canvas: HTMLCanvasElement): PointerCanvasProxy {
    const handlers = new Map<string, EventListener[]>();
    const proxy = {
        get width(): number {
            return canvas.width;
        },
        get height(): number {
            return canvas.height;
        },
        get clientWidth(): number {
            return canvas.clientWidth;
        },
        get clientHeight(): number {
            return canvas.clientHeight;
        },
        addEventListener(type: string, handler: EventListener): void {
            const registered = handlers.get(type);
            if (registered) {
                registered.push(handler);
            } else {
                handlers.set(type, [handler]);
            }
        },
        removeEventListener(type: string, handler: EventListener): void {
            const registered = handlers.get(type);
            const index = registered?.indexOf(handler) ?? -1;
            if (index >= 0) {
                registered!.splice(index, 1);
            }
        },
        setAttribute(): void {},
        setPointerCapture(pointerId: number): void {
            canvas.setPointerCapture(pointerId);
        },
        releasePointerCapture(pointerId: number): void {
            canvas.releasePointerCapture(pointerId);
        },
    } as unknown as HTMLCanvasElement;

    return {
        canvas: proxy,
        emit(type, event): void {
            const registered = handlers.get(type);
            if (!registered) {
                return;
            }
            for (const handler of registered) {
                handler.call(proxy, event);
            }
        },
    };
}

function positionDrags(gizmo: PositionGizmo): PointerDrag[] {
    return [
        gizmo.xGizmo.drag,
        gizmo.yGizmo.drag,
        gizmo.zGizmo.drag,
        ...(gizmo.xPlaneGizmo ? [gizmo.xPlaneGizmo.drag] : []),
        ...(gizmo.yPlaneGizmo ? [gizmo.yPlaneGizmo.drag] : []),
        ...(gizmo.zPlaneGizmo ? [gizmo.zPlaneGizmo.drag] : []),
    ];
}

function dragForMesh(drags: readonly PointerDrag[], mesh: Mesh): PointerDrag | null {
    for (const drag of drags) {
        if (drag._colliders.includes(mesh)) {
            return drag;
        }
    }
    return null;
}

/** Keep the racer's editor hover picking independent from the engine gizmo dispatcher.
 * Pointer-down picks use a proxy canvas and therefore never wait behind hover work. */
export function attachEditorPointerDrag(canvas: HTMLCanvasElement, layer: UtilityLayer, gizmo: PositionGizmo): { canvas: HTMLCanvasElement; dispose(): void } {
    const drags = positionDrags(gizmo);
    const proxy = createPointerCanvasProxy(canvas);
    for (const axis of [gizmo.xGizmo, gizmo.yGizmo, gizmo.zGizmo]) {
        axis._disposePointer();
        axis._disposePointer = registerPointerDrag(layer, proxy.canvas, axis.drag);
    }

    const hoverPicker: GpuPicker = createGpuPicker(layer.scene);
    let hovered: PointerDrag | null = null;
    let hoverInFlight = false;
    let hoverQueued = false;
    let hoverRevision = 0;
    let hoverX = 0;
    let hoverY = 0;
    let disposed = false;

    const setHovered = (next: PointerDrag | null): void => {
        if (next === hovered) {
            return;
        }
        if (hovered) {
            hovered.hovering = false;
            hovered.onHoverEnd.notify();
        }
        hovered = next;
        if (next) {
            next.hovering = true;
            next.onHoverStart.notify();
        }
    };

    const runHoverPick = async (): Promise<void> => {
        hoverInFlight = true;
        const revision = hoverRevision;
        try {
            const info = await pickAsync(hoverPicker, hoverX, hoverY);
            if (disposed || revision !== hoverRevision || isGizmoDragging(proxy.canvas) || isGizmoPickPending(proxy.canvas)) {
                return;
            }
            const drag = info.hit && info.pickedMesh ? dragForMesh(drags, info.pickedMesh as Mesh) : null;
            setHovered(drag?.enabled ? drag : null);
        } catch (error: unknown) {
            if (!disposed) {
                console.error("Antigravity Racer editor hover pick failed.", error);
            }
        } finally {
            hoverInFlight = false;
            if (hoverQueued && !disposed && !isGizmoDragging(proxy.canvas) && !isGizmoPickPending(proxy.canvas)) {
                hoverQueued = false;
                void runHoverPick();
            }
        }
    };

    const queueHover = (event: PointerEvent): void => {
        hoverX = event.offsetX;
        hoverY = event.offsetY;
        hoverRevision++;
        if (hoverInFlight) {
            hoverQueued = true;
        } else {
            void runHoverPick();
        }
    };

    const onPointerDown = (event: PointerEvent): void => {
        hoverRevision++;
        hoverQueued = false;
        setHovered(null);
        proxy.emit("pointerdown", event);
    };
    const onPointerMove = (event: PointerEvent): void => {
        if (isGizmoDragging(proxy.canvas)) {
            proxy.emit("pointermove", event);
        } else if (!isGizmoPickPending(proxy.canvas)) {
            queueHover(event);
        }
    };
    const onPointerUp = (event: PointerEvent): void => proxy.emit("pointerup", event);
    const onPointerCancel = (event: PointerEvent): void => proxy.emit("pointercancel", event);
    const onPointerLeave = (event: PointerEvent): void => {
        hoverRevision++;
        hoverQueued = false;
        setHovered(null);
        proxy.emit("pointerleave", event);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("pointerleave", onPointerLeave);

    return {
        canvas: proxy.canvas,
        dispose(): void {
            disposed = true;
            hoverRevision++;
            hoverQueued = false;
            setHovered(null);
            canvas.removeEventListener("pointerdown", onPointerDown);
            canvas.removeEventListener("pointermove", onPointerMove);
            canvas.removeEventListener("pointerup", onPointerUp);
            canvas.removeEventListener("pointercancel", onPointerCancel);
            canvas.removeEventListener("pointerleave", onPointerLeave);
            disposePicker(hoverPicker);
        },
    };
}
