import { isScene349CameraPose, readScene349Settings, SCENE349_CAMERAS, scene349Query } from "./shared/scene349-parallax.js";
import type { Scene349CameraPose } from "./shared/scene349-parallax.js";
import { installScene349Controls, reportScene349Error } from "./shared/scene349-parallax-ui.js";

function main(): void {
    const lite = document.getElementById("lite-frame") as HTMLIFrameElement;
    const babylon = document.getElementById("babylon-frame") as HTMLIFrameElement;
    const frames = [lite, babylon];

    let settings = readScene349Settings(location.search);
    let camera: Scene349CameraPose = { ...SCENE349_CAMERAS[settings.view] };

    const sendSettings = (frame: HTMLIFrameElement): void => {
        frame.contentWindow?.postMessage({ type: "scene349-settings", query: scene349Query(settings, true) }, location.origin);
    };
    const showFrameErrors = (): void => {
        const status = document.querySelector("[data-scene349-status]")!;
        const message = frames
            .map((frame) => frame.dataset.error)
            .filter(Boolean)
            .join(" ");
        status.textContent = message;
        status.classList.toggle("scene-error", message.length > 0);
    };
    installScene349Controls({ ...settings, embed: false }, "POM comparison", (next) => {
        if (next.view !== settings.view) {
            camera = { ...SCENE349_CAMERAS[next.view] };
        }
        settings = next;
        for (const frame of frames) {
            sendSettings(frame);
        }
    });
    const initialQuery = scene349Query(settings, true);
    lite.src = `/scene349.html?${initialQuery}`;
    babylon.src = `/babylon-ref-scene349.html?${initialQuery}`;
    history.replaceState(null, "", `?${scene349Query(settings, false)}`);

    window.addEventListener("message", (event: MessageEvent<unknown>) => {
        const source = frames.find((frame) => frame.contentWindow === event.source);
        if (event.origin !== location.origin || !source || !event.data || typeof event.data !== "object") {
            return;
        }
        const message = event.data as Record<string, unknown>;
        if (message.type === "scene349-ready") {
            sendSettings(source);
            source.contentWindow?.postMessage({ type: "scene349-set-camera", pose: camera }, location.origin);
            return;
        }
        if (message.type === "scene349-settings-applied") {
            delete source.dataset.error;
            if (message.query === scene349Query(settings, true)) {
                source.contentWindow?.postMessage({ type: "scene349-set-camera", pose: camera }, location.origin);
            }
            showFrameErrors();
        } else if (message.type === "scene349-error" && typeof message.message === "string") {
            source.dataset.error = `${source.title}: ${message.message}`;
            showFrameErrors();
        } else if (message.type === "scene349-camera" && isScene349CameraPose(message.pose)) {
            camera = message.pose;
            for (const frame of frames) {
                if (frame !== source) {
                    frame.contentWindow?.postMessage({ type: "scene349-set-camera", pose: camera }, location.origin);
                }
            }
        }
    });
}

try {
    main();
} catch (error) {
    reportScene349Error(error);
}
