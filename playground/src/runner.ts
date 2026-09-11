import { rebaseAssetReferences, withBase } from "./base";

export type RunnerMessage =
    | { type: "ready" }
    | { type: "ran" }
    | { type: "engine-ready" }
    | { type: "inspector"; open: boolean }
    | { type: "console"; level: "log" | "info" | "warn" | "error"; text: string }
    | { type: "error"; text: string }
    | { type: "stats"; fps: number };

/**
 * Owns the sandboxed runner iframe. Each run recreates the iframe so the previous
 * engine, canvas, and render loop are fully torn down before the next snippet runs
 * — a clean slate without needing a generic engine-dispose handle.
 */
export class Runner {
    private readonly host: HTMLElement;
    private readonly onMessage: (message: RunnerMessage) => void;
    private readonly onTeardown: () => void;
    private frame: HTMLIFrameElement | null = null;

    constructor(host: HTMLElement, onMessage: (message: RunnerMessage) => void, onTeardown: () => void) {
        this.host = host;
        this.onMessage = onMessage;
        this.onTeardown = onTeardown;
        window.addEventListener("message", this.handleMessage);
    }

    private handleMessage = (event: MessageEvent): void => {
        // The runner iframe is same-origin (`/runner.html`); reject anything else so a
        // cross-origin page (e.g. if user code navigates the iframe away) can't spoof it.
        if (event.origin !== window.location.origin) {
            return;
        }
        if (!this.frame || event.source !== this.frame.contentWindow) {
            return;
        }
        const message = event.data as RunnerMessage | undefined;
        if (message && typeof message.type === "string") {
            this.onMessage(message);
        }
    };

    /** Replace the iframe with a fresh one and run the given transpiled module code. */
    async run(code: string, engineUrl?: string, inspectorUrl?: string): Promise<void> {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
        const ready = this.waitForReady(frame);
        const params = new URLSearchParams();
        if (engineUrl) {
            params.set("engine", engineUrl);
        }
        if (inspectorUrl) {
            params.set("inspector", inspectorUrl);
        }
        frame.src = withBase(`runner.html${params.size > 0 ? `?${params}` : ""}`);

        this.dispose();
        this.frame = frame;
        this.host.appendChild(frame);

        await ready;
        // Same-origin iframe: target our own origin so code is never delivered to a
        // page that navigated the frame cross-origin. Rebase root-absolute asset
        // paths so same-origin assets resolve under a /pr or /v sub-path deploy.
        frame.contentWindow?.postMessage({ type: "run", code: rebaseAssetReferences(code) }, window.location.origin);
    }

    /** Toggle Inspector v2 for the engine created by the current snippet. */
    toggleInspector(): void {
        this.frame?.contentWindow?.postMessage({ type: "toggle-inspector" }, window.location.origin);
    }

    /** Tear down the current runner iframe, stopping its engine and render loop. */
    dispose(): void {
        if (this.frame) {
            this.frame.remove();
            this.frame = null;
            this.onTeardown();
        }
    }

    private waitForReady(frame: HTMLIFrameElement): Promise<void> {
        return new Promise((resolve) => {
            const listener = (event: MessageEvent): void => {
                if (event.origin !== window.location.origin) {
                    return;
                }
                if (event.source === frame.contentWindow && (event.data as RunnerMessage | undefined)?.type === "ready") {
                    window.removeEventListener("message", listener);
                    resolve();
                }
            };
            window.addEventListener("message", listener);
        });
    }
}
