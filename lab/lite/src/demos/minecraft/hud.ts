// DOM HUD overlay: a crosshair, a textured hotbar (slot backgrounds are the block
// face PNGs), and a toggleable debug readout. Pure DOM over the canvas — no GPU
// cost and trivially tree-shaken out if unused.

export interface HotbarSlotInfo {
    name: string;
    /** URL of a face texture to show as the slot icon. */
    iconUrl: string;
    key: string;
}

export class Hud {
    private readonly root: HTMLDivElement;
    private readonly slots: HTMLDivElement[] = [];
    private readonly debug: HTMLPreElement;
    private readonly fps: HTMLDivElement;
    private readonly help: HTMLDivElement;
    private debugVisible = false;
    private selected = 0;
    private toastEl?: HTMLDivElement;
    private toastTimer?: ReturnType<typeof setTimeout>;

    constructor(parent: HTMLElement, hotbar: HotbarSlotInfo[]) {
        this.root = document.createElement("div");
        this.root.style.cssText = "position:fixed;inset:0;pointer-events:none;font-family:system-ui,Segoe UI,sans-serif;z-index:10;";

        // Crosshair.
        const cross = document.createElement("div");
        cross.style.cssText =
            "position:absolute;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,-50%);" +
            "background:" +
            "linear-gradient(#fff,#fff) center/2px 22px no-repeat," +
            "linear-gradient(#fff,#fff) center/22px 2px no-repeat;" +
            "mix-blend-mode:difference;opacity:0.9;";
        this.root.appendChild(cross);

        // Hotbar.
        const bar = document.createElement("div");
        bar.style.cssText = "position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:4px;padding:4px;background:rgba(0,0,0,0.35);border-radius:6px;";
        hotbar.forEach((info) => {
            const slot = document.createElement("div");
            slot.title = info.name;
            slot.style.cssText =
                "width:50px;height:50px;border:2px solid rgba(255,255,255,0.25);border-radius:4px;" +
                `background:#222 url("${info.iconUrl}") center/cover;image-rendering:pixelated;position:relative;`;
            const num = document.createElement("span");
            num.textContent = info.key;
            num.style.cssText = "position:absolute;left:2px;top:0;color:#fff;font-size:11px;text-shadow:0 1px 2px #000;";
            slot.appendChild(num);
            bar.appendChild(slot);
            this.slots.push(slot);
        });
        this.root.appendChild(bar);

        // Help line.
        this.help = document.createElement("div");
        this.help.innerHTML = "Click to play · WASD move · Space jump · Shift sprint · Mouse look · L-click break · R-click place · 1-0 / Tab select · Ctrl+S save · Ctrl+O load · F3 debug";
        this.help.style.cssText = "position:absolute;left:50%;top:14px;transform:translateX(-50%);color:#fff;font-size:13px;text-shadow:0 1px 3px #000;background:rgba(0,0,0,0.3);padding:4px 10px;border-radius:4px;";
        this.root.appendChild(this.help);

        // Debug overlay.
        this.debug = document.createElement("pre");
        this.debug.style.cssText = "position:absolute;left:8px;top:8px;margin:0;color:#bfffbf;font:12px/1.4 monospace;text-shadow:0 1px 2px #000;display:none;white-space:pre;";
        this.root.appendChild(this.debug);

        // Always-visible FPS counter (top-right corner).
        this.fps = document.createElement("div");
        this.fps.textContent = "-- FPS";
        this.fps.style.cssText =
            "position:absolute;right:10px;top:10px;color:#9effa0;font:600 13px/1 monospace;" +
            "text-shadow:0 1px 2px #000;background:rgba(0,0,0,0.35);padding:4px 8px;border-radius:4px;";
        this.root.appendChild(this.fps);

        parent.appendChild(this.root);
        this.select(0);
    }

    select(i: number): void {
        const next = this.slots[i];
        if (!next) return;
        const prev = this.slots[this.selected];
        if (prev) {
            prev.style.borderColor = "rgba(255,255,255,0.25)";
            prev.style.transform = "scale(1)";
        }
        this.selected = i;
        next.style.borderColor = "#fff";
        next.style.transform = "scale(1.12)";
    }

    get selectedSlot(): number {
        return this.selected;
    }

    setDebug(text: string): void {
        if (this.debugVisible) this.debug.textContent = text;
    }

    setFps(fps: number): void {
        const v = Math.round(fps);
        this.fps.textContent = `${v} FPS`;
        // Green when smooth, amber mid, red when struggling.
        this.fps.style.color = v >= 50 ? "#9effa0" : v >= 30 ? "#ffd479" : "#ff8080";
    }

    toggleDebug(): void {
        this.debugVisible = !this.debugVisible;
        this.debug.style.display = this.debugVisible ? "block" : "none";
    }

    hideHelp(): void {
        this.help.style.display = "none";
    }

    /** Briefly show a centred status message (e.g. "World saved"). */
    toast(text: string): void {
        if (!this.toastEl) {
            this.toastEl = document.createElement("div");
            this.toastEl.style.cssText =
                "position:absolute;left:50%;top:64px;transform:translateX(-50%);color:#fff;font-size:14px;" +
                "text-shadow:0 1px 3px #000;background:rgba(0,0,0,0.55);padding:6px 14px;border-radius:5px;" +
                "opacity:0;transition:opacity 0.2s ease;";
            this.root.appendChild(this.toastEl);
        }
        this.toastEl.textContent = text;
        this.toastEl.style.opacity = "1";
        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            if (this.toastEl) this.toastEl.style.opacity = "0";
        }, 1800);
    }

    dispose(): void {
        this.root.remove();
    }
}
