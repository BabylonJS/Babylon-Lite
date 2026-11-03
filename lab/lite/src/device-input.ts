import {
    attachControl,
    createArcRotateCamera,
    createKeyboardInput,
    createPointerInput,
    disposeKeyboardInput,
    disposePointerInput,
    readGamepad,
    resetPointerInput,
    type GamepadState,
    type KeyboardInput,
    type PointerInput,
} from "babylon-lite";

export interface DeviceInputSnapshot {
    keys: string[];
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    wheelY: number;
    buttons: number;
    pointerId: number | null;
    pointerType: string;
}
export interface DeviceInputFixture {
    state(): DeviceInputSnapshot;
    secondState(): DeviceInputSnapshot;
    frameState(): DeviceInputSnapshot;
    reset(): void;
    dispose(): void;
    gamepad(): GamepadState | null;
    cameraMotion(): number;
    containerKeys(): string[];
}
function snapshot(keyboard: KeyboardInput, pointer: PointerInput): DeviceInputSnapshot {
    return {
        keys: [...keyboard.keys],
        x: pointer.x,
        y: pointer.y,
        deltaX: pointer.deltaX,
        deltaY: pointer.deltaY,
        wheelY: pointer.wheelY,
        buttons: pointer.buttons,
        pointerId: pointer.pointerId,
        pointerType: pointer.pointerType,
    };
}

const canvas = document.querySelector<HTMLCanvasElement>("#renderCanvas")!;
const frame = document.querySelector<HTMLIFrameElement>("#realm")!;
if (!frame.contentDocument?.querySelector("#frameCanvas")) {
    await new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
}
const frameCanvas = frame.contentDocument!.querySelector<HTMLCanvasElement>("#frameCanvas")!;
const containerKeyboard = createKeyboardInput(document.querySelector<HTMLElement>("#keyboard-container")!);
const keyboard = createKeyboardInput(canvas);
const pointer = createPointerInput(canvas);
const secondKeyboard = createKeyboardInput(canvas);
const secondPointer = createPointerInput(canvas);
const frameKeyboard = createKeyboardInput(frameCanvas);
const framePointer = createPointerInput(frameCanvas);
const camera = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
const detachCamera = attachControl(camera, canvas);
const fixture: DeviceInputFixture = {
    state: () => snapshot(keyboard, pointer),
    secondState: () => snapshot(secondKeyboard, secondPointer),
    frameState: () => snapshot(frameKeyboard, framePointer),
    reset: () => resetPointerInput(pointer),
    dispose: () => {
        disposeKeyboardInput(keyboard);
        disposePointerInput(pointer);
    },
    gamepad: () => readGamepad(),
    cameraMotion: () => camera.inertialAlphaOffset,
    containerKeys: () => [...containerKeyboard.keys],
};
Object.assign(window, { deviceInputFixture: fixture });
window.addEventListener(
    "pagehide",
    () => {
        fixture.dispose();
        disposeKeyboardInput(containerKeyboard);
        disposeKeyboardInput(secondKeyboard);
        disposePointerInput(secondPointer);
        disposeKeyboardInput(frameKeyboard);
        disposePointerInput(framePointer);
        detachCamera();
    },
    { once: true }
);
document.body.dataset.ready = "true";
