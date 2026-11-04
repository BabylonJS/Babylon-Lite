/**
 * Racer minimap — a small top-down HUD map of the circuit with a live car marker.
 * A 2D-canvas overlay (like the rest of the HUD), drawn from the track's loop
 * centreline so it always matches the built circuit; the car marker is a triangle
 * that points along the heading. Sits in the top-right corner.
 */

const MAP_SIZE = 150; // logical canvas size (px)
const MAP_PAD = 16; // inner padding so the road never touches the panel edge
const ROAD_WORLD = 9; // road width in world units → the map's road thickness
const ROAD_COLOR = "#3b3b44";
const ROAD_EDGE = "#1e1e26";
const CAR_COLOR = "#ffd27f";
const FINISH_COLOR = "#f4ece9";

/** A world-space XZ point. */
interface Pt {
    x: number;
    z: number;
}

/** A top-down circuit map with a live car marker, rendered to a small HUD canvas. */
export class Minimap {
    private readonly _ctx: CanvasRenderingContext2D;
    private readonly _path: readonly Pt[];
    private readonly _finish: Pt;
    private readonly _scale: number;
    private readonly _ox: number; // world→canvas offset (x)
    private readonly _oz: number; // world→canvas offset (z→y)

    constructor(path: readonly Pt[], finish: Pt) {
        this._path = path;
        this._finish = finish;

        // Fit the loop — inflated by the road width so the ribbon never clips — into the padded canvas.
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const p of path) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minZ = Math.min(minZ, p.z);
            maxZ = Math.max(maxZ, p.z);
        }
        const half = ROAD_WORLD / 2 + 1;
        minX -= half;
        maxX += half;
        minZ -= half;
        maxZ += half;
        const worldW = maxX - minX;
        const worldH = maxZ - minZ;
        const inner = MAP_SIZE - 2 * MAP_PAD;
        this._scale = inner / Math.max(worldW, worldH);
        // Centre the (wider-than-tall) circuit within the square panel.
        this._ox = MAP_PAD + (inner - worldW * this._scale) / 2 - minX * this._scale;
        this._oz = MAP_PAD + (inner - worldH * this._scale) / 2 - minZ * this._scale;

        const dpr = Math.max(1, devicePixelRatio);
        const canvas = document.createElement("canvas");
        canvas.id = "racer-minimap";
        canvas.width = Math.round(MAP_SIZE * dpr);
        canvas.height = Math.round(MAP_SIZE * dpr);
        canvas.style.cssText = `position:fixed;top:12px;right:12px;width:${MAP_SIZE}px;height:${MAP_SIZE}px;z-index:10;pointer-events:none;`;
        document.body.appendChild(canvas);
        const ctx = canvas.getContext("2d")!;
        ctx.scale(canvas.width / MAP_SIZE, canvas.height / MAP_SIZE); // draw in logical px at the exact rounded backing-store ratio
        this._ctx = ctx;
    }

    /** Redraw the map with the car at world (x, z) heading along unit (fx, fz). */
    update(x: number, z: number, fx: number, fz: number): void {
        const ctx = this._ctx;
        ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

        // Translucent rounded panel.
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        this._roundRect(0.5, 0.5, MAP_SIZE - 1, MAP_SIZE - 1, 12);
        ctx.fill();

        // Road ribbon: a thick closed polyline through the loop centreline, dark edge under a lighter fill.
        const road = ROAD_WORLD * this._scale;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        for (let i = 0; i < this._path.length; i++) {
            const p = this._path[i]!;
            const px = this._ox + p.x * this._scale;
            const py = this._oz + p.z * this._scale;
            if (i === 0) {
                ctx.moveTo(px, py);
            } else {
                ctx.lineTo(px, py);
            }
        }
        ctx.closePath();
        ctx.strokeStyle = ROAD_EDGE;
        ctx.lineWidth = road + 3;
        ctx.stroke();
        ctx.strokeStyle = ROAD_COLOR;
        ctx.lineWidth = road;
        ctx.stroke();

        // Start/finish dot.
        ctx.beginPath();
        ctx.arc(this._ox + this._finish.x * this._scale, this._oz + this._finish.z * this._scale, 3, 0, Math.PI * 2);
        ctx.fillStyle = FINISH_COLOR;
        ctx.fill();

        // Car marker: a triangle pointing along the heading (world +x → right, +z → down).
        const cx = this._ox + x * this._scale;
        const cy = this._oz + z * this._scale;
        const len = Math.hypot(fx, fz) || 1;
        const dx = fx / len;
        const dz = fz / len;
        const tip = 6; // tip distance ahead of the car
        const wing = 3.6; // half-width of the base
        ctx.beginPath();
        ctx.moveTo(cx + dx * tip, cy + dz * tip);
        ctx.lineTo(cx - dx * tip * 0.6 - dz * wing, cy - dz * tip * 0.6 + dx * wing);
        ctx.lineTo(cx - dx * tip * 0.6 + dz * wing, cy - dz * tip * 0.6 - dx * wing);
        ctx.closePath();
        ctx.fillStyle = CAR_COLOR;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.stroke();
    }

    /** Trace a rounded rectangle path (kept local to avoid relying on ctx.roundRect). */
    private _roundRect(x: number, y: number, w: number, h: number, r: number): void {
        const ctx = this._ctx;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }
}
