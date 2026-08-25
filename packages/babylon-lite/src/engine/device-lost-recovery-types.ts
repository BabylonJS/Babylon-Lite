/** Callback surface shared by public rendering-context device-recovery enablers. */
export interface DeviceLostRecoveryCallbacks {
    /** Called immediately after loss is detected and before a replacement device is requested. */
    onLost?: (info: GPUDeviceLostInfo) => void;
    /** Called after the replacement device, surfaces, and enabled rendering contexts are ready. */
    onRecovered?: () => void;
    /** Called when replacement-device acquisition or rendering-context rebuilding fails. */
    onRecoveryFailed?: (error: unknown) => void;
}

/** Idempotent handle returned by a public rendering-context recovery enabler. */
export interface DeviceLostRecoveryHandle {
    disable(): void;
}
