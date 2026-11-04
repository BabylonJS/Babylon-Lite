import { isScene348CameraPose, readScene348Settings, SCENE348_ASSETS, SCENE348_PANEL_SIZE, scene348Query } from "./scene348-parallax.js";
import type { Scene348CameraPose, Scene348Settings } from "./scene348-parallax.js";

export function reportScene348Error(error: unknown, canvas: HTMLCanvasElement | null = document.querySelector("canvas")): void {
    const message = error instanceof Error ? error.message : String(error);
    if (canvas) {
        canvas.dataset.error = message;
    }
    let status = document.querySelector<HTMLElement>("[data-scene348-status]");
    if (!status) {
        status = document.createElement("p");
        status.dataset.scene348Status = "";
        status.className = "scene-header";
        status.setAttribute("role", "alert");
        document.body.prepend(status);
    }
    status.classList.add("scene-error");
    status.textContent = message;
    window.dispatchEvent(new CustomEvent("scene-load-error", { detail: message }));
    if (window.parent !== window) {
        window.parent.postMessage({ type: "scene348-error", message }, location.origin);
    }
    console.error("Scene 348 failed:", error);
}

export function installScene348Controls(settings: Scene348Settings, implementation: string, apply: (settings: Scene348Settings) => void): void {
    if (settings.embed) {
        document.body.classList.add("embedded");
        return;
    }
    const header = document.createElement("header");
    header.className = "scene-header";
    header.innerHTML = `<div class="scene-title"><h1>Scene 348: ${implementation}</h1><nav>
<a data-scene-link="compare" href="/lite/compare-scene348.html">Side by side</a>
<a data-scene-link="lite" href="/scene348.html">Lite</a>
<a data-scene-link="bjs" href="/babylon-ref-scene348.html">Babylon.js</a>
</nav></div>
<form class="scene-controls">
<label>Right column <select name="pom"><option value="on">POM on</option><option value="off">POM off</option></select></label>
<label>View <select name="view"><option value="front">Front</option><option value="oblique">Oblique</option><option value="grazing">Grazing</option></select></label>
<label>Texture <select name="asset"><option value="stone">Stone (Playground)</option><option value="wall">Brick wall (Playground)</option></select></label>
<label>Lite quality <select name="quality"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
<label>Inset ratio <input name="depth" type="range" min="0" max="0.16" step="0.01"><output name="depthValue"></output></label>
</form>
<p>Top: Standard. Bottom: PBR. Left: normal-map-only control. Right: POM. Drag to orbit; wheel to zoom.</p>
<p class="scene-note">Native Babylon.js marching vs Lite contact refinement; not pixel-identical. <span class="depth-note"></span> <span data-scene348-status role="status"></span></p>`;
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
            `Lite world depth: ${(SCENE348_PANEL_SIZE * Number(depthInput.value)).toFixed(3)}. BJS scale bias: ${Number(depthInput.value).toFixed(2)}.`;
    };
    updateDepthLabel();
    const updateLinks = (next: Scene348Settings): void => {
        for (const link of header.querySelectorAll<HTMLAnchorElement>("[data-scene-link]")) {
            const url = new URL(link.href);
            url.search = scene348Query(next, false);
            link.href = url.href;
        }
    };
    updateLinks(settings);
    form.addEventListener("submit", (event) => event.preventDefault());
    let currentQuery = scene348Query(settings);
    const submitSettings = (): void => {
        const data = new FormData(form);
        const next: Scene348Settings = {
            ...settings,
            pom: data.get("pom") === "on",
            view: data.get("view") as Scene348Settings["view"],
            asset: data.get("asset") as Scene348Settings["asset"],
            quality: data.get("quality") as Scene348Settings["quality"],
            depth: Number(data.get("depth")),
        };
        updateDepthLabel();
        updateLinks(next);
        const query = scene348Query(next);
        if (query !== currentQuery) {
            currentQuery = query;
            history.replaceState(null, "", `?${query}`);
            apply(next);
        }
    };
    depthInput.addEventListener("input", submitSettings);
    form.addEventListener("change", submitSettings);
}

export function installScene348LiveUpdates(
    initial: Scene348Settings,
    canvas: HTMLCanvasElement,
    apply: (settings: Scene348Settings, previous: Scene348Settings) => Promise<void>
): void {
    let current = initial;
    let pending: Scene348Settings | null = null;
    let applying: Scene348Settings | null = null;
    let running = false;
    let version = 0;
    canvas.dataset.updating = "false";
    const parentMessage = (message: object): void => {
        if (window.parent !== window) {
            window.parent.postMessage(message, location.origin);
        }
    };
    const publish = (): void => {
        const assets = SCENE348_ASSETS[current.asset];
        canvas.dataset.pom = current.pom ? "on" : "off";
        canvas.dataset.depth = String(current.depth);
        canvas.dataset.asset = current.asset;
        canvas.dataset.quality = current.quality;
        canvas.dataset.view = current.view;
        canvas.dataset.colorTexture = assets.color;
        canvas.dataset.heightTexture = assets.normalHeight;
        canvas.dataset.settingsVersion = String(version);
        delete canvas.dataset.error;
        const status = document.querySelector("[data-scene348-status]");
        if (status) {
            status.textContent = "";
            status.classList.remove("scene-error");
        }
        history.replaceState(null, "", `?${scene348Query(current)}`);
        parentMessage({ type: "scene348-settings-applied", query: scene348Query(current, true) });
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
                .catch((error: unknown) => reportScene348Error(error, canvas))
                .finally(() => {
                    running = false;
                    canvas.dataset.updating = "false";
                    if (pending) {
                        schedule();
                    }
                });
        });
    };
    const request = (next: Scene348Settings): void => {
        if (canvas.dataset.error === undefined && scene348Query(next, true) === scene348Query(pending ?? applying ?? current, true)) {
            return;
        }
        pending = next;
        schedule();
    };
    installScene348Controls(initial, canvas.dataset.implementation === "lite" ? "Babylon Lite" : "Babylon.js native POM", request);
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (event.origin !== location.origin || event.source !== window.parent || !event.data || typeof event.data !== "object") {
            return;
        }
        const message = event.data as Record<string, unknown>;
        if (message.type === "scene348-settings" && typeof message.query === "string") {
            try {
                request(readScene348Settings(message.query));
            } catch (error) {
                reportScene348Error(error, canvas);
            }
        }
    });
    publish();
    parentMessage({ type: "scene348-ready" });
}

export function installScene348CameraSync(camera: Scene348CameraPose, canvas: HTMLCanvasElement): () => void {
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
        if (message.type !== "scene348-set-camera" || !isScene348CameraPose(message.pose)) {
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
            window.parent.postMessage({ type: "scene348-camera", pose: { alpha, beta, radius } }, location.origin);
        }
    };
}
