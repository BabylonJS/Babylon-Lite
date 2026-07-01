/**
 * Throwing stubs for the Babylon.js `Cameras/Inputs` family and its
 * `CameraInputsManager` container.
 *
 * Babylon.js models camera control as a pluggable collection of per-input
 * handlers (`camera.inputs`), each a small `ICameraInput` implementation that
 * owns its own keys/sensitivity/button config. Babylon Lite instead attaches a
 * single, self-contained control implementation to a camera — the compat
 * `camera.attachControl()` / `detachControl()` forward to it wholesale, with no
 * per-input granularity to configure.
 *
 * Because the individual input classes cannot be backed 1:1 on the Lite API,
 * every symbol here throws {@link LiteCompatError} on construction so a ported
 * scene that reaches for `new FreeCameraKeyboardMoveInput()` (or
 * `camera.inputs.add(...)`) fails loudly with a pointer to `attachControl`
 * instead of a bare "not exported" error. See the **Cameras** section of
 * `COMPAT-STATUS.md`.
 */

import { unsupported } from "../error.js";

const INPUTS_DETAIL =
    "Babylon Lite attaches a single control implementation per camera; use the compat `camera.attachControl()` / `detachControl()` instead of the per-input `camera.inputs` handlers.";

/**
 * Babylon.js `ICameraInput` — a single pluggable camera-input handler. Declared
 * here for type-parity; there is no per-input handler surface on Babylon Lite.
 */
export interface ICameraInput<TCamera> {
    camera: TCamera;
    getClassName(): string;
    getSimpleName(): string;
    attachControl(noPreventDefault?: boolean): void;
    detachControl(): void;
    checkInputs?: () => void;
}

/** Babylon.js `CameraInputsManager` — the `camera.inputs` container. Not backed by the Lite control API. */
export class CameraInputsManager<TCamera> {
    /** The camera this manager belongs to (unreachable — the constructor throws). */
    public camera!: TCamera;

    public constructor() {
        unsupported("CameraInputsManager", INPUTS_DETAIL);
    }
}

// ─── Base inputs ─────────────────────────────────────────────────────
export class BaseCameraMouseWheelInput {
    public constructor() {
        unsupported("BaseCameraMouseWheelInput", INPUTS_DETAIL);
    }
}

export class BaseCameraPointersInput {
    public constructor() {
        unsupported("BaseCameraPointersInput", INPUTS_DETAIL);
    }
}

// ─── ArcRotateCamera inputs ──────────────────────────────────────────
export class ArcRotateCameraGamepadInput {
    public constructor() {
        unsupported("ArcRotateCameraGamepadInput", INPUTS_DETAIL);
    }
}

export class ArcRotateCameraKeyboardMoveInput {
    public constructor() {
        unsupported("ArcRotateCameraKeyboardMoveInput", INPUTS_DETAIL);
    }
}

export class ArcRotateCameraMouseWheelInput {
    public constructor() {
        unsupported("ArcRotateCameraMouseWheelInput", INPUTS_DETAIL);
    }
}

export class ArcRotateCameraPointersInput {
    public constructor() {
        unsupported("ArcRotateCameraPointersInput", INPUTS_DETAIL);
    }
}

export class ArcRotateCameraVRDeviceOrientationInput {
    public constructor() {
        unsupported("ArcRotateCameraVRDeviceOrientationInput", INPUTS_DETAIL);
    }
}

// ─── FlyCamera inputs ────────────────────────────────────────────────
export class FlyCameraKeyboardInput {
    public constructor() {
        unsupported("FlyCameraKeyboardInput", INPUTS_DETAIL);
    }
}

export class FlyCameraMouseInput {
    public constructor() {
        unsupported("FlyCameraMouseInput", INPUTS_DETAIL);
    }
}

// ─── FollowCamera inputs ─────────────────────────────────────────────
export class FollowCameraKeyboardMoveInput {
    public constructor() {
        unsupported("FollowCameraKeyboardMoveInput", INPUTS_DETAIL);
    }
}

export class FollowCameraMouseWheelInput {
    public constructor() {
        unsupported("FollowCameraMouseWheelInput", INPUTS_DETAIL);
    }
}

export class FollowCameraPointersInput {
    public constructor() {
        unsupported("FollowCameraPointersInput", INPUTS_DETAIL);
    }
}

// ─── FreeCamera inputs ───────────────────────────────────────────────
export class FreeCameraDeviceOrientationInput {
    public constructor() {
        unsupported("FreeCameraDeviceOrientationInput", INPUTS_DETAIL);
    }
}

export class FreeCameraGamepadInput {
    public constructor() {
        unsupported("FreeCameraGamepadInput", INPUTS_DETAIL);
    }
}

export class FreeCameraKeyboardMoveInput {
    public constructor() {
        unsupported("FreeCameraKeyboardMoveInput", INPUTS_DETAIL);
    }
}

export class FreeCameraMouseInput {
    public constructor() {
        unsupported("FreeCameraMouseInput", INPUTS_DETAIL);
    }
}

export class FreeCameraMouseWheelInput {
    public constructor() {
        unsupported("FreeCameraMouseWheelInput", INPUTS_DETAIL);
    }
}

export class FreeCameraTouchInput {
    public constructor() {
        unsupported("FreeCameraTouchInput", INPUTS_DETAIL);
    }
}

export class FreeCameraVirtualJoystickInput {
    public constructor() {
        unsupported("FreeCameraVirtualJoystickInput", INPUTS_DETAIL);
    }
}

// ─── GeospatialCamera inputs ─────────────────────────────────────────
export class GeospatialCameraPointersInput {
    public constructor() {
        unsupported("GeospatialCameraPointersInput", INPUTS_DETAIL);
    }
}

export class GeospatialCameraMouseWheelInput {
    public constructor() {
        unsupported("GeospatialCameraMouseWheelInput", INPUTS_DETAIL);
    }
}

export class GeospatialCameraKeyboardInput {
    public constructor() {
        unsupported("GeospatialCameraKeyboardInput", INPUTS_DETAIL);
    }
}
