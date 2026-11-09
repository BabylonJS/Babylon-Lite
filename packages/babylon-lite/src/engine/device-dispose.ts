import type { DeviceContext } from "./device.js";

/** Destroy an unclaimed device, including one passed to a failed `createEngine` call.
 *  Once an engine owns it, `disposeEngine` destroys it and this function is a no-op.
 *  Repeated disposal is harmless. */
export function disposeDevice(device: DeviceContext): void {
    if (!device._claimed) {
        device._claimed = true;
        device._device.destroy();
    }
}
