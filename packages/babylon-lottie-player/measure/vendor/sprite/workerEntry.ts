// Keep only type-only imports at module scope so nothing with side-effects runs in the worker at load time
import { type Nullable } from "./babylonTypes";
import { type RawLottieAnimation } from "./parsing/rawTypes";
import { type AnimationController } from "./rendering/animationController";
import {
    type Message,
    type AnimationSizeMessage,
    type AnimationUrlMessagePayload,
    type StartAnimationMessagePayload,
    type ContainerResizeMessagePayload,
    type WorkerLoadedMessage,
} from "./messageTypes";

let RawAnimation: Nullable<RawLottieAnimation> = null;
let Controller: Nullable<AnimationController> = null;

// Pre-warmed module exports - stored during pre-warm phase for faster access
let GetRawAnimationDataAsync: any = null;
let ControllerModule: any = null;
let AnimationControllerPromise: any = null;

onmessage = async function (evt) {
    const message = evt.data as Message;
    if (message === undefined) {
        return;
    }

    switch (message.type) {
        case "preWarm": {
            let success = true;
            let errorString = undefined;
            try {
                // Load modules and store their exports
                const parserModule = await import("./parsing/rawAnimation");
                const controllerModule = await import("./rendering/animationController");

                // Store the actual exports we'll need
                GetRawAnimationDataAsync = parserModule.GetRawAnimationDataAsync;
                ControllerModule = controllerModule;
            } catch (error: unknown) {
                success = false;
                errorString = error instanceof Error ? error.message : String(error);
            }

            const sizeMessage: WorkerLoadedMessage = {
                type: "workerLoaded",
                payload: {
                    success: success,
                    error: errorString,
                },
            };

            postMessage(sizeMessage);
            break;
        }
        case "animationUrl": {
            const payload = message.payload as AnimationUrlMessagePayload;

            // If the Controller was not pre-warmed, start loading it now
            if (ControllerModule === null) {
                AnimationControllerPromise = import("./rendering/animationController");
            }

            // Use pre-warmed parser if available, otherwise load it
            if (GetRawAnimationDataAsync === null) {
                const parserModule = await import("./parsing/rawAnimation");
                // We are ok having a race condition here, as both should resolve to the same function
                GetRawAnimationDataAsync = parserModule.GetRawAnimationDataAsync;
            }

            RawAnimation = await GetRawAnimationDataAsync(payload.url);
            if (RawAnimation === null) {
                return;
            }

            // Send this information back to the main thread so it can size the canvas correctly
            const sizeMessage: AnimationSizeMessage = {
                type: "animationSize",
                payload: {
                    width: RawAnimation.w,
                    height: RawAnimation.h,
                },
            };

            postMessage(sizeMessage);
            break;
        }
        case "startAnimation": {
            // If we have started loading the Controller, finish loading it
            if (AnimationControllerPromise !== null) {
                ControllerModule = await AnimationControllerPromise;
            }

            // If we did not attempt to load the Controller earlier, load it now
            if (ControllerModule === null) {
                ControllerModule = await import("./rendering/animationController");
            }

            const payload = message.payload as StartAnimationMessagePayload;
            if (RawAnimation === null && payload.animationData) {
                RawAnimation = payload.animationData;
            }

            if (RawAnimation === null) {
                return;
            }

            const controller = await ControllerModule.createAnimationControllerAsync(
                payload.canvas,
                RawAnimation,
                payload.canvasScale,
                payload.atlasScale,
                payload.variables ?? new Map<string, string>(),
                payload.configuration ?? {},
                payload.mainThreadDevicePixelRatio,
                () => {
                    postMessage({ type: "firstRender", payload: {} });
                }
            );

            ControllerModule.playAnimation(controller);
            Controller = controller;
            break;
        }
        case "containerResize": {
            if (Controller === null) {
                return;
            }

            const payload = message.payload as ContainerResizeMessagePayload;
            ControllerModule.setControllerScale(Controller, payload.canvasScale);
            break;
        }
        case "dispose": {
            if (Controller) {
                ControllerModule.disposeAnimationController(Controller);
                Controller = null;
            }

            if (RawAnimation) {
                RawAnimation = null;
            }

            GetRawAnimationDataAsync = null;
            ControllerModule = null;
            AnimationControllerPromise = null;
            break;
        }
        default:
            return;
    }
};
