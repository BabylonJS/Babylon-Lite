import type { PickingInfo } from "../culling/picking-info.js";

/** Babylon.js pointer event masks emitted by `Scene.onPointerObservable`. */
export class PointerEventTypes {
    public static readonly POINTERDOWN = 0x01;
    public static readonly POINTERUP = 0x02;
    public static readonly POINTERMOVE = 0x04;
    public static readonly POINTERWHEEL = 0x08;
    public static readonly POINTERPICK = 0x10;
    public static readonly POINTERTAP = 0x20;
    public static readonly POINTERDOUBLETAP = 0x40;
}

/** Babylon.js-shaped payload emitted by `Scene.onPointerObservable`. */
export class PointerInfo {
    public constructor(
        public type: number,
        public event: PointerEvent | WheelEvent,
        private readonly _pickInfo: PickingInfo | null
    ) {}

    public get pickInfo(): PickingInfo | null {
        return this._pickInfo;
    }
}
