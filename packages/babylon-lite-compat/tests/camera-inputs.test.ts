import { describe, expect, it } from "vitest";

import { LiteCompatError } from "../src/error";
import {
    CameraInputsManager,
    BaseCameraMouseWheelInput,
    BaseCameraPointersInput,
    ArcRotateCameraGamepadInput,
    ArcRotateCameraKeyboardMoveInput,
    ArcRotateCameraMouseWheelInput,
    ArcRotateCameraPointersInput,
    ArcRotateCameraVRDeviceOrientationInput,
    FlyCameraKeyboardInput,
    FlyCameraMouseInput,
    FollowCameraKeyboardMoveInput,
    FollowCameraMouseWheelInput,
    FollowCameraPointersInput,
    FreeCameraDeviceOrientationInput,
    FreeCameraGamepadInput,
    FreeCameraKeyboardMoveInput,
    FreeCameraMouseInput,
    FreeCameraMouseWheelInput,
    FreeCameraTouchInput,
    FreeCameraVirtualJoystickInput,
    GeospatialCameraPointersInput,
    GeospatialCameraMouseWheelInput,
    GeospatialCameraKeyboardInput,
} from "../src/unsupported/camera-inputs";

describe("Camera input handler stubs throw on construction", () => {
    const cases: Array<[string, () => unknown]> = [
        ["CameraInputsManager", () => new CameraInputsManager()],
        ["BaseCameraMouseWheelInput", () => new BaseCameraMouseWheelInput()],
        ["BaseCameraPointersInput", () => new BaseCameraPointersInput()],
        ["ArcRotateCameraGamepadInput", () => new ArcRotateCameraGamepadInput()],
        ["ArcRotateCameraKeyboardMoveInput", () => new ArcRotateCameraKeyboardMoveInput()],
        ["ArcRotateCameraMouseWheelInput", () => new ArcRotateCameraMouseWheelInput()],
        ["ArcRotateCameraPointersInput", () => new ArcRotateCameraPointersInput()],
        ["ArcRotateCameraVRDeviceOrientationInput", () => new ArcRotateCameraVRDeviceOrientationInput()],
        ["FlyCameraKeyboardInput", () => new FlyCameraKeyboardInput()],
        ["FlyCameraMouseInput", () => new FlyCameraMouseInput()],
        ["FollowCameraKeyboardMoveInput", () => new FollowCameraKeyboardMoveInput()],
        ["FollowCameraMouseWheelInput", () => new FollowCameraMouseWheelInput()],
        ["FollowCameraPointersInput", () => new FollowCameraPointersInput()],
        ["FreeCameraDeviceOrientationInput", () => new FreeCameraDeviceOrientationInput()],
        ["FreeCameraGamepadInput", () => new FreeCameraGamepadInput()],
        ["FreeCameraKeyboardMoveInput", () => new FreeCameraKeyboardMoveInput()],
        ["FreeCameraMouseInput", () => new FreeCameraMouseInput()],
        ["FreeCameraMouseWheelInput", () => new FreeCameraMouseWheelInput()],
        ["FreeCameraTouchInput", () => new FreeCameraTouchInput()],
        ["FreeCameraVirtualJoystickInput", () => new FreeCameraVirtualJoystickInput()],
        ["GeospatialCameraPointersInput", () => new GeospatialCameraPointersInput()],
        ["GeospatialCameraMouseWheelInput", () => new GeospatialCameraMouseWheelInput()],
        ["GeospatialCameraKeyboardInput", () => new GeospatialCameraKeyboardInput()],
    ];

    it.each(cases)("%s throws LiteCompatError naming the API", (name, construct) => {
        expect(construct).toThrow(LiteCompatError);
        expect(construct).toThrow(new RegExp(name));
    });
});
