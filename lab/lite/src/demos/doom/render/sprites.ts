// Clean-room DOOM sprite decoding + atlas packing for the demo.
//
// Sprites live in the WAD between S_START and S_END marker lumps. Each lump name
// is 4 sprite-name chars + a frame letter + a rotation digit, optionally followed
// by a second frame+rotation pair meaning "this image is also used, mirrored, for
// that frame/rotation" (e.g. TROOA2A8 = frame A rot 2, and frame A rot 8 mirrored).
//
// Rotation 0 means a single image used for all viewing angles. Rotations 1..8 are
// the eight directions, with 1 = front (monster facing the viewer) and increasing
// counter-clockwise.
//
// We decode only the sprites requested by the active mobj set and pack them into a
// single indexed atlas texture (R = palette index, A = coverage) shared by every
// billboard, so all sprites render through one faithful colormap material.
//
// Implemented from public Doom format documentation; no GPL Doom source is used.

import { createTexture2DFromPixels, type EngineContext, type SpriteAtlas, type SpriteFrame, type Texture2D } from "babylon-lite";
import type { Wad } from "../wad/wad-file.js";
import { getLump } from "../wad/wad-file.js";
import { decodePatch } from "../wad/graphics.js";

/** One placed sprite image: its atlas rect (in pixels), pivot offsets and mirror flag. */
export interface SpriteImage {
    /** Atlas pixel rect. */
    ax: number;
    ay: number;
    aw: number;
    ah: number;
    /** Patch pivot (distance from top-left to the mobj origin), in pixels. */
    leftOffset: number;
    topOffset: number;
    /** When true the image must be sampled horizontally flipped. */
    mirror: boolean;
    /** Index of this image's frame in the shared {@link SpriteAtlas} (assigned at pack time). */
    frameIndex: number;
}

/** All rotations for one animation frame of one sprite. */
interface DoomSpriteFrame {
    /** True when the frame has 8 distinct rotations; false when a single image is used. */
    rotated: boolean;
    /** Index 0..7 for rotations 1..8 (or [0] only when not rotated). */
    rots: (SpriteImage | null)[];
}

interface RawRot {
    lumpIndex: number;
    frame: number;
    rot: number;
    mirror: boolean;
}

const ATLAS_WIDTH = 1024;

export class SpriteStore {
    /** spriteName -> frame index -> DoomSpriteFrame. */
    private readonly frames = new Map<string, DoomSpriteFrame[]>();
    /** Raw rotation records discovered in the S namespace, keyed by sprite name. */
    private readonly raw = new Map<string, RawRot[]>();
    private _atlas: Texture2D | null = null;
    private _atlasW = 0;
    private _atlasH = 0;
    private _spriteAtlas: SpriteAtlas | null = null;

    constructor(
        private readonly engine: EngineContext,
        private readonly wad: Wad
    ) {
        this.scanNamespace();
    }

    get atlas(): Texture2D | null {
        return this._atlas;
    }
    get atlasWidth(): number {
        return this._atlasW;
    }
    get atlasHeight(): number {
        return this._atlasH;
    }

    /** The packed atlas as a `SpriteAtlas` (one frame per `SpriteImage`), or null before `build()`. */
    get spriteAtlas(): SpriteAtlas | null {
        return this._spriteAtlas;
    }

    /** Discovers every sprite lump in the S_START..S_END namespace (no decode yet). */
    private scanNamespace(): void {
        const lumps = this.wad.lumps;
        let inNs = false;
        for (let i = 0; i < lumps.length; i++) {
            const name = lumps[i]!.name;
            if (name === "S_START" || name === "SS_START") {
                inNs = true;
                continue;
            }
            if (name === "S_END" || name === "SS_END") {
                inNs = false;
                continue;
            }
            if (!inNs || lumps[i]!.size === 0) continue;
            this.indexLump(name, i);
        }
    }

    private indexLump(name: string, lumpIndex: number): void {
        if (name.length < 6) return;
        const sprite = name.slice(0, 4);
        addRaw(this.raw, sprite, {
            lumpIndex,
            frame: name.charCodeAt(4) - 65,
            rot: name.charCodeAt(5) - 48,
            mirror: false,
        });
        if (name.length >= 8) {
            addRaw(this.raw, sprite, {
                lumpIndex,
                frame: name.charCodeAt(6) - 65,
                rot: name.charCodeAt(7) - 48,
                mirror: true,
            });
        }
    }

    /** Returns true when a sprite name exists in this WAD. */
    has(sprite: string): boolean {
        return this.raw.has(sprite);
    }

    /**
     * Decodes the requested sprites and (re)builds the shared atlas. Idempotent for a
     * given name set; call once after the mobj set is known.
     */
    build(spriteNames: Iterable<string>): void {
        interface Pending {
            sprite: string;
            frame: number;
            rotSlot: number;
            rotated: boolean;
            img: SpriteImage;
            pixels: { indices: Uint8Array; opaque: Uint8Array; w: number; h: number };
        }
        const pending: Pending[] = [];

        for (const sprite of spriteNames) {
            const records = this.raw.get(sprite);
            if (!records || this.frames.has(sprite)) continue;
            const frameList: DoomSpriteFrame[] = [];
            this.frames.set(sprite, frameList);

            // Decode each unique lump once, then assign to the rotation slots it serves.
            const decoded = new Map<number, { indices: Uint8Array; opaque: Uint8Array; w: number; h: number; left: number; top: number }>();
            for (const rec of records) {
                if (!decoded.has(rec.lumpIndex)) {
                    const img = decodePatch(getLump(this.wad, rec.lumpIndex));
                    decoded.set(rec.lumpIndex, {
                        indices: img.indices,
                        opaque: img.opaque,
                        w: img.width,
                        h: img.height,
                        left: img.leftOffset,
                        top: img.topOffset,
                    });
                }
                const d = decoded.get(rec.lumpIndex)!;
                let frame = frameList[rec.frame];
                if (!frame) {
                    frame = { rotated: rec.rot !== 0, rots: rec.rot === 0 ? [null] : [null, null, null, null, null, null, null, null] };
                    frameList[rec.frame] = frame;
                }
                if (rec.rot !== 0 && !frame.rotated) {
                    frame.rotated = true;
                    frame.rots = [null, null, null, null, null, null, null, null];
                }
                const slot = rec.rot === 0 ? 0 : rec.rot - 1;
                const image: SpriteImage = { ax: 0, ay: 0, aw: d.w, ah: d.h, leftOffset: d.left, topOffset: d.top, mirror: rec.mirror, frameIndex: -1 };
                frame.rots[slot] = image;
                pending.push({ sprite, frame: rec.frame, rotSlot: slot, rotated: frame.rotated, img: image, pixels: d });
            }
        }

        if (pending.length === 0 && !this._atlas) return;
        if (pending.length === 0) return;

        this.packAndUpload(pending);
    }

    private packAndUpload(pending: { img: SpriteImage; pixels: { indices: Uint8Array; opaque: Uint8Array; w: number; h: number } }[]): void {
        // Shelf packer: place tallest-first into rows of fixed width ATLAS_WIDTH.
        const items = pending.slice().sort((a, b) => b.pixels.h - a.pixels.h);
        const pad = 1;
        let x = pad;
        let y = pad;
        let shelfH = 0;
        let maxX = 0;
        for (const it of items) {
            const w = it.pixels.w;
            const h = it.pixels.h;
            if (x + w + pad > ATLAS_WIDTH) {
                x = pad;
                y += shelfH + pad;
                shelfH = 0;
            }
            it.img.ax = x;
            it.img.ay = y;
            x += w + pad;
            if (h > shelfH) shelfH = h;
            if (x > maxX) maxX = x;
        }
        const atlasH = nextPow2(y + shelfH + pad);
        const atlasW = nextPow2(maxX);

        const rgba = new Uint8Array(atlasW * atlasH * 4);
        for (const it of items) {
            const { indices, opaque, w, h } = it.pixels;
            const ox = it.img.ax;
            const oy = it.img.ay;
            for (let yy = 0; yy < h; yy++) {
                for (let xx = 0; xx < w; xx++) {
                    const si = yy * w + xx;
                    if (!opaque[si]) continue;
                    const di = ((oy + yy) * atlasW + (ox + xx)) * 4;
                    rgba[di] = indices[si]!;
                    rgba[di + 3] = 255;
                }
            }
        }

        this._atlas = createTexture2DFromPixels(this.engine, rgba, atlasW, atlasH, {
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });
        this._atlasW = atlasW;
        this._atlasH = atlasH;

        // Build the billboard-facing SpriteAtlas: one frame per packed image. The DOOM patch
        // pivot (leftOffset/topOffset) and mirror flag are folded into the frame pivot so the
        // billboard quad anchors exactly where the hand-built mesh used to. Mirrored images keep
        // the source UVs (flip is applied per-instance via `flipX`) but mirror the pivot X.
        const frames: SpriteFrame[] = [];
        for (const it of items) {
            const img = it.img;
            const pivotX = img.mirror ? (img.aw - img.leftOffset) / img.aw : img.leftOffset / img.aw;
            const pivotY = img.topOffset / img.ah;
            img.frameIndex = frames.length;
            frames.push({
                uvMin: [img.ax / atlasW, img.ay / atlasH],
                uvMax: [(img.ax + img.aw) / atlasW, (img.ay + img.ah) / atlasH],
                sourceSizePx: [img.aw, img.ah],
                pivot: [pivotX, pivotY],
            });
        }
        this._spriteAtlas = { texture: this._atlas, textureSizePx: [atlasW, atlasH], frames, premultipliedAlpha: false };
    }

    /**
     * Selects the sprite image to show for a mobj given its facing and the viewer.
     * Returns null if the frame is undefined (caller should skip drawing).
     */
    pick(sprite: string, frame: number, mobjAngleRad: number, mobjX: number, mobjY: number, viewX: number, viewY: number): SpriteImage | null {
        const list = this.frames.get(sprite);
        const f = list?.[frame];
        if (!f) return null;
        if (!f.rotated) return f.rots[0] ?? null;
        // BAM angle math (documented Doom sprite-rotation selection).
        const viewToThing = radToBam(Math.atan2(mobjY - viewY, mobjX - viewX));
        const thingAngle = radToBam(mobjAngleRad);
        const rot = ((viewToThing - thingAngle + 0x90000000) >>> 29) & 7;
        return f.rots[rot] ?? f.rots[0] ?? null;
    }
}

function addRaw(map: Map<string, RawRot[]>, sprite: string, rec: RawRot): void {
    const arr = map.get(sprite);
    if (arr) arr.push(rec);
    else map.set(sprite, [rec]);
}

function radToBam(rad: number): number {
    // Map radians to a 32-bit binary-angle measure (BAM), unsigned.
    const t = rad / (Math.PI * 2);
    const frac = t - Math.floor(t);
    return (frac * 0x100000000) >>> 0;
}

function nextPow2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}
