import { isScene348CameraPose, readScene348Settings, SCENE348_CAMERAS, scene348Query } from "./shared/scene348-parallax.js";
import type { Scene348CameraPose } from "./shared/scene348-parallax.js";
import { installScene348Controls, reportScene348Error } from "./shared/scene348-parallax-ui.js";

function main(): void {
    const lite = document.getElementById("lite-frame") as HTMLIFrameElement;
    const babylon = document.getElementById("babylon-frame") as HTMLIFrameElement;
    const frames = [lite, babylon];

    let settings = readScene348Settings(location.search);
    let camera: Scene348CameraPose = { ...SCENE348_CAMERAS[settings.view] };

    const sendSettings = (frame: HTMLIFrameElement): void => {
        frame.contentWindow?.postMessage({ type: "scene348-settings", query: scene348Query(settings, true) }, location.origin);
    };
    const showFrameErrors = (): void => {
        const status = document.querySelector("[data-scene348-status]")!;
        const message = frames
            .map((frame) => frame.dataset.error)
            .filter(Boolean)
            .join(" ");
        status.textContent = message;
        status.classList.toggle("scene-error", message.length > 0);
    };
    installScene348Controls({ ...settings, embed: false }, "POM comparison", (next) => {
        if (next.view !== settings.view) {
            camera = { ...SCENE348_CAMERAS[next.view] };
        }
        settings = next;
        for (const frame of frames) {
            sendSettings(frame);
        }
    });
    const initialQuery = scene348Query(settings, true);
    lite.src = `/scene348.html?${initialQuery}`;
    babylon.src = `/babylon-ref-scene348.html?${initialQuery}`;
    history.replaceState(null, "", `?${scene348Query(settings, false)}`);

    window.addEventListener("message", (event: MessageEvent<unknown>) => {
        const source = frames.find((frame) => frame.contentWindow === event.source);
        if (event.origin !== location.origin || !source || !event.data || typeof event.data !== "object") {
            return;
        }
        const message = event.data as Record<string, unknown>;
        if (message.type === "scene348-ready") {
            sendSettings(source);
            source.contentWindow?.postMessage({ type: "scene348-set-camera", pose: camera }, location.origin);
            return;
        }
        if (message.type === "scene348-settings-applied") {
            delete source.dataset.error;
            if (message.query === scene348Query(settings, true)) {
                source.contentWindow?.postMessage({ type: "scene348-set-camera", pose: camera }, location.origin);
            }
            showFrameErrors();
        } else if (message.type === "scene348-error" && typeof message.message === "string") {
            source.dataset.error = `${source.title}: ${message.message}`;
            showFrameErrors();
        } else if (message.type === "scene348-camera" && isScene348CameraPose(message.pose)) {
            camera = message.pose;
            for (const frame of frames) {
                if (frame !== source) {
                    frame.contentWindow?.postMessage({ type: "scene348-set-camera", pose: camera }, location.origin);
                }
            }
        }
    });
}

try {
    main();
} catch (error) {
    reportScene348Error(error);
}
