import type { AbstractEngine } from "../engine/engine.js";
import { unsupported } from "../error.js";
import { Observable } from "../misc/observable.js";

const DEVICE_SOURCE_BLOCKER =
    "Lite's standalone keyboard, pointer, and gamepad helpers expose application-owned state snapshots. Babylon.js DeviceSourceManager additionally defines multi-device slot classification, connect/disconnect lifecycles, numeric polling indices, and normalized per-input event payloads; matching that contract requires a new Lite-owned input-management subsystem and lifecycle design.";

export enum DeviceType {
    Generic = 0,
    Keyboard = 1,
    Mouse = 2,
    Touch = 3,
    DualShock = 4,
    Xbox = 5,
    Switch = 6,
    DualSense = 7,
}

export enum PointerInput {
    Horizontal = 0,
    Vertical = 1,
    LeftClick = 2,
    MiddleClick = 3,
    RightClick = 4,
    BrowserBack = 5,
    BrowserForward = 6,
    MouseWheelX = 7,
    MouseWheelY = 8,
    MouseWheelZ = 9,
    Move = 12,
}

export const enum DeviceInputEventType {
    PointerMove,
    PointerDown,
    PointerUp,
}

export interface IUIEvent {
    inputIndex: number;
    currentTarget?: any;
    srcElement?: any;
    type: string;
    target: any;
    preventDefault: () => void;
}

export interface IKeyboardEvent extends IUIEvent {
    altKey: boolean;
    charCode?: number;
    code: string;
    ctrlKey: boolean;
    key: string;
    keyCode: number;
    metaKey: boolean;
    shiftKey: boolean;
    repeat?: boolean;
}

export interface IMouseEvent extends IUIEvent {
    inputIndex: Exclude<PointerInput, PointerInput.Horizontal | PointerInput.Vertical>;
    altKey: boolean;
    button: number;
    buttons: number;
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
    detail?: number;
    metaKey: boolean;
    movementX: number;
    movementY: number;
    mozMovementX?: number;
    mozMovementY?: number;
    msMovementX?: number;
    msMovementY?: number;
    offsetX: number;
    offsetY: number;
    pageX: number;
    pageY: number;
    shiftKey: boolean;
    webkitMovementX?: number;
    webkitMovementY?: number;
    x: number;
    y: number;
}

export interface IPointerEvent extends IMouseEvent {
    inputIndex: Exclude<PointerInput, PointerInput.Horizontal | PointerInput.Vertical | PointerInput.MouseWheelX | PointerInput.MouseWheelY | PointerInput.MouseWheelZ>;
    pointerId: number;
    pointerType: string;
}

export interface IWheelEvent extends IMouseEvent {
    inputIndex: PointerInput.MouseWheelX | PointerInput.MouseWheelY | PointerInput.MouseWheelZ;
    deltaMode: number;
    deltaX: number;
    deltaY: number;
    deltaZ: number;
    wheelDelta?: number;
}

export class EventConstants {
    public static DOM_DELTA_PIXEL = 0x00;
    public static DOM_DELTA_LINE = 0x01;
    public static DOM_DELTA_PAGE = 0x02;
}

export const enum DualShockInput {
    Cross = 0,
    Circle = 1,
    Square = 2,
    Triangle = 3,
    L1 = 4,
    R1 = 5,
    L2 = 6,
    R2 = 7,
    Share = 8,
    Options = 9,
    L3 = 10,
    R3 = 11,
    DPadUp = 12,
    DPadDown = 13,
    DPadLeft = 14,
    DPadRight = 15,
    Home = 16,
    TouchPad = 17,
    LStickXAxis = 18,
    LStickYAxis = 19,
    RStickXAxis = 20,
    RStickYAxis = 21,
}

export const enum DualSenseInput {
    Cross = 0,
    Circle = 1,
    Square = 2,
    Triangle = 3,
    L1 = 4,
    R1 = 5,
    L2 = 6,
    R2 = 7,
    Create = 8,
    Options = 9,
    L3 = 10,
    R3 = 11,
    DPadUp = 12,
    DPadDown = 13,
    DPadLeft = 14,
    DPadRight = 15,
    Home = 16,
    TouchPad = 17,
    LStickXAxis = 18,
    LStickYAxis = 19,
    RStickXAxis = 20,
    RStickYAxis = 21,
}

export const enum XboxInput {
    A = 0,
    B = 1,
    X = 2,
    Y = 3,
    LB = 4,
    RB = 5,
    LT = 6,
    RT = 7,
    Back = 8,
    Start = 9,
    LS = 10,
    RS = 11,
    DPadUp = 12,
    DPadDown = 13,
    DPadLeft = 14,
    DPadRight = 15,
    Home = 16,
    LStickXAxis = 17,
    LStickYAxis = 18,
    RStickXAxis = 19,
    RStickYAxis = 20,
}

export const enum SwitchInput {
    B = 0,
    A = 1,
    Y = 2,
    X = 3,
    L = 4,
    R = 5,
    ZL = 6,
    ZR = 7,
    Minus = 8,
    Plus = 9,
    LS = 10,
    RS = 11,
    DPadUp = 12,
    DPadDown = 13,
    DPadLeft = 14,
    DPadRight = 15,
    Home = 16,
    Capture = 17,
    LStickXAxis = 18,
    LStickYAxis = 19,
    RStickXAxis = 20,
    RStickYAxis = 21,
}

export type DeviceInput<T extends DeviceType> = T extends DeviceType.Keyboard | DeviceType.Generic
    ? number
    : T extends DeviceType.Mouse | DeviceType.Touch
      ? Exclude<PointerInput, PointerInput.Move | PointerInput.MouseWheelX | PointerInput.MouseWheelY | PointerInput.MouseWheelZ>
      : T extends DeviceType.DualShock
        ? DualShockInput
        : T extends DeviceType.Xbox
          ? XboxInput
          : T extends DeviceType.Switch
            ? SwitchInput
            : T extends DeviceType.DualSense
              ? DualSenseInput
              : never;

export type DeviceSourceEvent<T extends DeviceType> = T extends DeviceType.Keyboard
    ? IKeyboardEvent
    : T extends DeviceType.Mouse
      ? IWheelEvent | IPointerEvent
      : T extends DeviceType.Touch
        ? IPointerEvent
        : never;

export class DeviceSource<T extends DeviceType> {
    public readonly onInputChangedObservable = new Observable<DeviceSourceEvent<T>>();

    public constructor(
        _deviceInputSystem: unknown,
        public readonly deviceType: T,
        public readonly deviceSlot = 0
    ) {
        unsupported("DeviceSource", DEVICE_SOURCE_BLOCKER);
    }

    public getInput(_inputIndex: DeviceInput<T>): number {
        return unsupported("DeviceSource.getInput", DEVICE_SOURCE_BLOCKER);
    }
}

export class DeviceSourceManager {
    public readonly onDeviceConnectedObservable = new Observable<DeviceSource<DeviceType>>();
    public readonly onDeviceDisconnectedObservable = new Observable<DeviceSource<DeviceType>>();

    public constructor(_engine: AbstractEngine) {
        unsupported("DeviceSourceManager", DEVICE_SOURCE_BLOCKER);
    }

    public getDeviceSource<T extends DeviceType>(_deviceType: T, _deviceSlot?: number): DeviceSource<T> | null {
        return unsupported("DeviceSourceManager.getDeviceSource", DEVICE_SOURCE_BLOCKER);
    }

    public getDeviceSources<T extends DeviceType>(_deviceType: T): ReadonlyArray<DeviceSource<T>> {
        return unsupported("DeviceSourceManager.getDeviceSources", DEVICE_SOURCE_BLOCKER);
    }

    public dispose(): void {
        unsupported("DeviceSourceManager.dispose", DEVICE_SOURCE_BLOCKER);
    }
}
