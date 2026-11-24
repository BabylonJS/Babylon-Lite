import { isScene349CameraPose, readScene349Settings, SCENE349_ASSETS, SCENE349_PANEL_SIZE, scene349Query } from "./scene349-parallax.js";
import type { Scene349CameraPose, Scene349Settings } from "./scene349-parallax.js";

export function reportScene349Error(error: unknown, canvas: HTMLCanvasElement | null = document.querySelector("canvas")): void {
    const message = error instanceof Error ? error.message : String(error);
    if (canvas) {
        canvas.dataset.error = message;
    }
    let status = document.querySelector<HTMLElement>("[data-scene349-status]");
    if (!status) {
        status = document.createElement("p");
        status.dataset.scene349Status = "";
        status.className = "scene-header";
        status.setAttribute("role", "alert");
        document.body.prepend(status);
    }
    status.classList.add("scene-error");
    status.textContent = message;
    window.dispatchEvent(new CustomEvent("scene-load-error", { detail: message }));
    if (window.parent !== window) {
        window.parent.postMessage({ type: "scene349-error", message }, location.origin);
    }
    console.error("Scene 349 failed:", error);
}

export function installScene349Controls(settings: Scene349Settings, implementation: string, apply: (settings: Scene349Settings) => void): void {
    if (settings.embed) {
        document.body.classList.add("embedded");
        return;
    }
    const header = document.createElement("header");
    header.className = "scene-header";
    header.innerHTML = `<div class="scene-title"><h1>Scene 349: ${implementation}</h1><nav>
<a data-scene-link="compare" href="/lite/compare-scene349.html">Side by side</a>
<a data-scene-link="lite" href="/scene349.html">Lite</a>
<a data-scene-link="bjs" href="/babylon-ref-scene349.html">Babylon.js</a>
</nav></div>
<form class="scene-controls">
<label>Right column <select name="pom"><option value="on">POM on</option><option value="off">POM off</option></select></label>
<label>View <select name="view"><option value="front">Front</option><option value="oblique">Oblique</option><option value="grazing">Grazing</option></select></label>
<label>Texture <select name="asset"><option value="stone">Stone (Playground)</option><option value="wall">Brick wall (Playground)</option></select></label>
<label>Lite quality <select name="quality"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
<label>Inset ratio <input name="depth" type="range" min="0" max="0.16" step="0.01"><output name="depthValue"></output></label>
</form>
<p>Top: Standard. Bottom: PBR. Left: normal-map-only control. Right: POM. Drag to orbit; wheel to zoom.</p>
<p class="scene-note">Native Babylon.js marching vs Lite contact refinement; not pixel-identical. <span class="depth-note"></span> <span data-scene349-status role="status"></span></p>`;
    document.body.prepend(header);
    const form = header.querySelector("form")!;
    for (const key of ["pom", "view", "asset", "quality", "depth"] as const) {
        const element = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement;
        element.value = key === "pom" ? (settings.pom ? "on" : "off") : String(settings[key]);
    }
    const depthInput = form.elements.namedItem("depth") as HTMLInputElement;
    const output = form.elements.namedItem("depthValue") as HTMLOutputElement;
    const updateDepthLabel = (): void => {
        output.value = Number(depthInput.value).toFixed(2);
        header.querySelector(".depth-note")!.textContent =
            `Lite world depth: ${(SCENE349_PANEL_SIZE * Number(depthInput.value)).toFixed(3)}. BJS scale bias: ${Number(depthInput.value).toFixed(2)}.`;
    };
    updateDepthLabel();
    const updateLinks = (next: Scene349Settings): void => {
        for (const link of header.querySelectorAll<HTMLAnchorElement>("[data-scene-link]")) {
            const url = new URL(link.href);
            url.search = scene349Query(next, false);
            link.href = url.href;
        }
    };
    updateLinks(settings);
    form.addEventListener("submit", (event) => event.preventDefault());
    let currentQuery = scene349Query(settings);
    const submitSettings = (): void => {
        const data = new FormData(form);
        const next: Scene349Settings = {
            ...settings,
            pom: data.get("pom") === "on",
            view: data.get("view") as Scene349Settings["view"],
            asset: data.get("asset") as Scene349Settings["asset"],
            quality: data.get("quality") as Scene349Settings["quality"],
            depth: Number(data.get("depth")),
        };
        updateDepthLabel();
        updateLinks(next);
        const query = scene349Query(next);
        if (query !== currentQuery) {
            currentQuery = query;
            history.replaceState(null, "", `?${query}`);
            apply(next);
        }
    };
    depthInput.addEventListener("input", submitSettings);
    form.addEventListener("change", submitSettings);
}

export function installScene349LiveUpdates(
    initial: Scene349Settings,
    canvas: HTMLCanvasElement,
    apply: (settings: Scene349Settings, previous: Scene349Settings) => Promise<void>
): void {
    let current = initial;
    let pending: Scene349Settings | null = null;
    let applying: Scene349Settings | null = null;
    let running = false;
    let version = 0;
    canvas.dataset.updating = "false";
    const parentMessage = (message: object): void => {
        if (window.parent !== window) {
            window.parent.postMessage(message, location.origin);
        }
    };
    const publish = (): void => {
        const assets = SCENE349_ASSETS[current.asset];
        canvas.dataset.pom = current.pom ? "on" : "off";
        canvas.dataset.depth = String(current.depth);
        canvas.dataset.asset = current.asset;
        canvas.dataset.quality = current.quality;
        canvas.dataset.view = current.view;
        canvas.dataset.colorTexture = assets.color;
        canvas.dataset.heightTexture = assets.normalHeight;
        canvas.dataset.settingsVersion = String(version);
        delete canvas.dataset.error;
        const status = document.querySelector("[data-scene349-status]");
        if (status) {
            status.textContent = "";
            status.classList.remove("scene-error");
        }
        history.replaceState(null, "", `?${scene349Query(current)}`);
        parentMessage({ type: "scene349-settings-applied", query: scene349Query(current, true) });
    };
    const drain = async (): Promise<void> => {
        while (pending) {
            const next = pending;
            pending = null;
            applying = next;
            try {
                await apply(next, current);
                current = next;
                version++;
                publish();
            } finally {
                applying = null;
            }
        }
    };
    const schedule = (): void => {
        if (running) {
            return;
        }
        running = true;
        canvas.dataset.updating = "true";
        requestAnimationFrame(() => {
            void drain()
                .catch((error: unknown) => reportScene349Error(error, canvas))
                .finally(() => {
                    running = false;
                    canvas.dataset.updating = "false";
                    if (pending) {
                        schedule();
                    }
                });
        });
    };
    const request = (next: Scene349Settings): void => {
        if (canvas.dataset.error === undefined && scene349Query(next, true) === scene349Query(pending ?? applying ?? current, true)) {
            return;
        }
        pending = next;
        schedule();
    };
    installScene349Controls(initial, canvas.dataset.implementation === "lite" ? "Babylon Lite" : "Babylon.js native POM", request);
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (event.origin !== location.origin || event.source !== window.parent || !event.data || typeof event.data !== "object") {
            return;
        }
        const message = event.data as Record<string, unknown>;
        if (message.type === "scene349-settings" && typeof message.query === "string") {
            try {
                request(readScene349Settings(message.query));
            } catch (error) {
                reportScene349Error(error, canvas);
            }
        }
    });
    publish();
    parentMessage({ type: "scene349-ready" });
}

export function installScene349CameraSync(camera: Scene349CameraPose, canvas: HTMLCanvasElement): () => void {
    let alpha = camera.alpha;
    let beta = camera.beta;
    let radius = camera.radius;
    const updatePose = (): void => {
        canvas.dataset.cameraAlpha = String(alpha);
        canvas.dataset.cameraBeta = String(beta);
        canvas.dataset.cameraRadius = String(radius);
    };
    updatePose();
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (event.origin !== location.origin || event.source !== window.parent || !event.data || typeof event.data !== "object") {
            return;
        }
        const message = event.data as Record<string, unknown>;
        if (message.type !== "scene349-set-camera" || !isScene349CameraPose(message.pose)) {
            return;
        }
        camera.alpha = alpha = message.pose.alpha;
        camera.beta = beta = message.pose.beta;
        camera.radius = radius = message.pose.radius;
        updatePose();
    });
    return () => {
        if (camera.alpha === alpha && camera.beta === beta && camera.radius === radius) {
            return;
        }
        alpha = camera.alpha;
        beta = camera.beta;
        radius = camera.radius;
        updatePose();
        if (window.parent !== window) {
            window.parent.postMessage({ type: "scene349-camera", pose: { alpha, beta, radius } }, location.origin);
        }
    };
}
