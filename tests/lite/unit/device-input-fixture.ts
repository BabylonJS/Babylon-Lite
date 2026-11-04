export function inputFixture() {
    const doc = Object.assign(new EventTarget(), { hidden: false, pointerLockElement: null as HTMLElement | null });
    const view = Object.assign(new EventTarget(), { document: doc });
    Object.assign(doc, { defaultView: view });
    const element = Object.assign(new EventTarget(), {
        ownerDocument: doc,
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }),
    }) as unknown as HTMLElement;
    function emit(target: EventTarget, type: string, values: Record<string, unknown> = {}, path: EventTarget[] = [element, doc, view]): Event {
        const event = Object.assign(new Event(type, { cancelable: true }), values, { composedPath: () => path });
        target.dispatchEvent(event);
        return event;
    }
    function pointer(type: string, values: Record<string, unknown> = {}, path?: EventTarget[]): Event {
        return emit(view, type, { isPrimary: true, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 20, buttons: 0, movementX: 0, movementY: 0, ...values }, path);
    }
    return { doc, view: view as unknown as Window, element, emit, pointer };
}
