/**
 * Racer speed lines — a stylised full-screen overlay of radial streaks that ramps
 * in with speed, reinforcing the sense of velocity. It's a 2D canvas overlay (not
 * a post-process), so the crisp MSAA render is untouched and the cartoon look is
 * preserved. Streaks stream outward from the centre and fade at the edges.
 */

const STREAKS = 54; // radial streaks drawn per frame
const SPEED_ON = 0.4; // fraction of top speed at which lines start to appear
const INNER = 0.42; // streaks begin this far out from the centre (keeps the middle clear)

function clamp01(v: number): number {
    return Math.min(1, Math.max(0, v));
}

export class SpeedLines {
    private readonly _canvas: HTMLCanvasElement;
    private readonly _ctx: CanvasRenderingContext2D;
    private _phase = 0;
    private readonly _onResize: () => void;

    constructor() {
        const canvas = document.createElement("canvas");
        canvas.id = "racer-speed-lines";
        canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:9;pointer-events:none;";
        document.body.appendChild(canvas);
        this._canvas = canvas;
        this._ctx = canvas.getContext("2d")!;
        this._onResize = (): void => {
            canvas.width = Math.max(1, Math.floor(window.innerWidth * devicePixelRatio));
            canvas.height = Math.max(1, Math.floor(window.innerHeight * devicePixelRatio));
        };
        this._onResize();
        window.addEventListener("resize", this._onResize);
    }

    /** Draw one frame of streaks scaled by |speed| (~0..1). */
    update(dt: number, speed: number): void {
        const ctx = this._ctx;
        const w = this._canvas.width;
        const h = this._canvas.height;
        ctx.clearRect(0, 0, w, h);

        const intensity = clamp01((Math.abs(speed) - SPEED_ON) / (1 - SPEED_ON));
        if (intensity <= 0.01) {
            return;
        }
        this._phase = (this._phase + dt * (0.6 + 1.6 * intensity)) % 1;

        const cx = w / 2;
        const cy = h / 2;
        const maxR = Math.hypot(cx, cy);
        ctx.lineCap = "round";
        for (let i = 0; i < STREAKS; i++) {
            const angle = (i / STREAKS) * Math.PI * 2 + Math.sin(i * 12.9898) * 0.05;
            const t = (this._phase + i * 0.618033) % 1; // golden-ratio stagger so they don't pulse together
            const r0 = (INNER + t * (1 - INNER)) * maxR;
            const len = maxR * 0.14 * intensity;
            const fade = Math.sin(Math.PI * t); // ramp in past the centre, fade out at the edge
            const alpha = intensity * fade * 0.5;
            if (alpha <= 0.01) {
                continue;
            }
            const ca = Math.cos(angle);
            const sa = Math.sin(angle);
            ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
            ctx.lineWidth = (1 + intensity) * devicePixelRatio;
            ctx.beginPath();
            ctx.moveTo(cx + ca * r0, cy + sa * r0);
            ctx.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len));
            ctx.stroke();
        }
    }
}
