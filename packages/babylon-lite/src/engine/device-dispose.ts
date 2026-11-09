import type { DeviceContext } from "./device.js";

/** Destroy a device that was never passed to `createEngine`. Once an engine owns the device,
 *  `disposeEngine` destroys it and this is a no-op. Repeated disposal is harmless. */
export function disposeDevice(device: DeviceContext): void {
    if (!device._claimed) {
        device._claimed = true;
        device._device.destroy();
    }
}
