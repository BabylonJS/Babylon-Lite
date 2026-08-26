// Parse: walk a Lottie document's shape layers into a flat, plain-data draw list.
// We keep animatable values as raw props (sampled per frame); only the static
// gradient stops are pre-parsed.

import type { Asset, FontDef, Layer, LottieFile, Prop, ShapeItem } from "./lottie-raw.js";

/** A map of placeholder text → replacement string, applied at parse time to text-layer content for
 *  runtime localization. A text layer whose raw content EXACTLY matches a key is rendered with the
 *  mapped value instead (whole-string match, mirroring the original Babylon.js Lottie player). */
export type LottieVariables = Readonly<Record<string, string>>;

/** Options for {@link createLottiePlayer} / `createShapePlayer`. */
export interface LottiePlayerOptions {
    /** Runtime text substitutions for localization — see {@link LottieVariables}. */
    variables?: LottieVariables;
}

export interface GradientStops {
    count: number;
    /** Raw color/opacity stop data, sampled per frame. */
    data: Prop;
}

export interface SolidPaint {
    kind: "solid";
    /** rgba color prop (components 0–1). */
    color: Prop;
}

export interface GradientPaint {
    kind: "linear" | "radial";
    /** Gradient start point (shape-local). */
    start: Prop;
    /** Gradient end point (shape-local). */
    end: Prop;
    stops: GradientStops;
}

export interface StrokePaint {
    kind: "stroke";
    /** rgba color prop (components 0–1). */
    color: Prop;
    /** Stroke width prop (shape-local units). */
    width: Prop;
    /** Lottie line cap style; only `1` (butt) differs from the round fallback. */
    cap?: number;
}

export type Paint = SolidPaint | GradientPaint | StrokePaint;

/** A rectangle primitive source (center, size, corner roundness). */
export interface RectSource {
    /** Center position. */
    p: Prop;
    /** Size [w, h]. */
    s: Prop;
    /** Corner roundness (radius). */
    r?: Prop;
}

/** An ellipse primitive source (center, size). */
export interface EllipseSource {
    /** Center position. */
    p: Prop;
    /** Size [w, h] (diameters). */
    s: Prop;
}

/** One contour of a (possibly compound) shape: a bezier path, a rect, or an ellipse. */
export interface Contour {
    path?: Prop;
    rect?: RectSource;
    ellipse?: EllipseSource;
}

/** Lottie transform fields (anchor, position, scale, rotation, opacity). */
export interface Transform {
    a?: Prop;
    p?: Prop;
    s?: Prop;
    r?: Prop;
    o?: Prop;
}

export interface DrawOp {
    /**
     * Contours filled together as ONE compound path. Multiple contours with opposite winding
     * (e.g. a glyph outline + its counter) produce holes via the nonzero winding rule — they
     * are stencilled together before a single cover pass.
     */
    contours: Contour[];
    /** Group transforms ordered from outermost to innermost. */
    transforms: Transform[];
    paint: Paint;
    /** Paint opacity (0–100), if any. */
    paintOpacity?: Prop;
}

/** A decoded reference to an image asset (resolved from a layer's `refId`). */
export interface ParsedImage {
    /** Index into `ParsedAnimation.assets`. */
    assetIndex: number;
    width: number;
    height: number;
}

/** A parsed text document (resolved to a CSS-ready font). */
export interface ParsedText {
    text: string;
    /** CSS font family (e.g. "Segoe UI"). */
    family: string;
    /** CSS font weight (e.g. 400, 600, 700). */
    weight: number;
    /** CSS font style ("normal" | "italic"). */
    style: string;
    /** Font size in px. */
    size: number;
    /** Fill color [r,g,b,a] in 0–1. */
    color: [number, number, number, number];
    /** Justify: 0 left, 1 right, 2 center. */
    justify: number;
    /** Letter spacing in px. */
    letterSpacing: number;
    /** Line height in px. */
    lineHeight: number;
    /** Box width (boxed/paragraph text wraps within this; undefined for point text). */
    boxW?: number;
    /** Box height. */
    boxH?: number;
    /** Box top-left X in layer-local space. */
    boxX?: number;
    /** Box top-left Y in layer-local space. */
    boxY?: number;
}

/** An image asset with its (possibly embedded) source URI. */
export interface ParsedAsset {
    id: string;
    width: number;
    height: number;
    /** Path or `data:` URI. */
    src: string;
}

/** A parsed layer mask. The path is sampled per frame (it can morph). */
export interface ParsedMask {
    /** Mask mode: "a" add, "s" subtract, "i" intersect, etc. Only "a" (add) is rendered today. */
    mode: string;
    /** Inverted (mask the OUTSIDE of the path). */
    inverted: boolean;
    /** Mask path (animatable shape). */
    path: Prop;
    /** Mask opacity prop (0–100), if any. */
    opacity?: Prop;
}

export interface ParsedLayer {
    /** Lottie layer type (`4` shape, `2` image, `3` null/transform-only). Renderers dispatch on this. */
    kind: number;
    /** Layer index (`ind`), used to resolve parent references. */
    ind: number;
    /** Parent layer index, for transform chaining. */
    parent?: number;
    name: string;
    transform: Transform;
    ip: number;
    op: number;
    st: number;
    /** Shape draw ops in Lottie array order (render back-to-front == iterate in reverse). */
    ops: DrawOp[];
    /** Image reference, for image layers. */
    image?: ParsedImage;
    /** Text document, for text layers. */
    text?: ParsedText;
    /** Layer masks (clip the layer's content). Undefined when the layer has none. */
    masks?: ParsedMask[];
    /** Track-matte mode on this consumer. Only alpha (`1`) is rendered today. */
    matteMode?: number;
    /** `ind` of the matte source layer. */
    matteSource?: number;
    /** This layer supplies matte coverage and is not painted independently. */
    matteOnly?: boolean;
}

export interface ParsedAnimation {
    width: number;
    height: number;
    ip: number;
    op: number;
    fr: number;
    layers: ParsedLayer[];
    assets: ParsedAsset[];
}

function parseGradient(it: ShapeItem): GradientPaint {
    return {
        kind: it.t === 2 ? "radial" : "linear",
        start: it.s as Prop,
        end: it.e as Prop,
        stops: { count: it.g!.p, data: it.g!.k },
    };
}

function walkGroup(items: ShapeItem[], ops: DrawOp[], parents: Transform[] = []): void {
    // A group's paths/rects combine into one compound shape that its fill(s) paint together.
    const contours: Contour[] = [];
    const groups: ShapeItem[][] = [];
    let transform: Transform | undefined;
    const paints: { paint: Paint; opacity?: Prop }[] = [];

    for (const it of items) {
        if (it.hd) {
            continue;
        }
        switch (it.ty) {
            case "gr":
                groups.push(it.it ?? []);
                break;
            case "sh":
                if (it.ks) {
                    contours.push({ path: it.ks });
                }
                break;
            case "rc":
                // Rect primitive: p center, s size, r corner roundness (ShapeItem.r is typed as fill rule).
                contours.push({ rect: { p: it.p as Prop, s: it.s as Prop, r: it.r as unknown as Prop | undefined } });
                break;
            case "el":
                // Ellipse primitive: p center, s size (diameters).
                contours.push({ ellipse: { p: it.p as Prop, s: it.s as Prop } });
                break;
            case "tr": {
                // On a transform item `r` is the rotation prop (ShapeItem.r is typed as the fill rule).
                const rotation = it.r as unknown as Prop | undefined;
                transform = { a: it.a, p: it.p, s: it.s, r: rotation, o: it.o };
                break;
            }
            case "fl":
                paints.push({ paint: { kind: "solid", color: it.c as Prop }, opacity: it.o });
                break;
            case "gf":
                paints.push({ paint: parseGradient(it), opacity: it.o });
                break;
            case "st":
                if (it.w) {
                    paints.push({ paint: { kind: "stroke", color: it.c as Prop, width: it.w, cap: it.lc }, opacity: it.o });
                }
                break;
            // "gs" (gradient strokes) not yet supported.
        }
    }

    const transforms = transform ? [...parents, transform] : parents;
    if (groups.length) {
        for (const group of groups) {
            walkGroup(group, ops, transforms);
        }
    }

    if (contours.length > 0) {
        for (const pt of paints) {
            ops.push({ contours, transforms, paint: pt.paint, paintOpacity: pt.opacity });
        }
    }
}

/** Derive a CSS weight + style from a Lottie font definition (name + style string). */
function fontWeightStyle(def: FontDef | undefined, fontName: string): { weight: number; style: string } {
    // Match against the style string and font name together (either may carry the weight/italic hint);
    // the space keeps tokens from fusing across the boundary (e.g. "…semi" + "bold…").
    const s = ((def?.fStyle ?? "") + " " + (def?.fName ?? fontName)).toLowerCase();
    let weight = 400;
    if (/black|heavy/.test(s)) {
        weight = 900;
    } else if (/semibold|demibold/.test(s)) {
        weight = 600;
    } else if (/bold/.test(s)) {
        weight = 700;
    } else if (/medium/.test(s)) {
        weight = 500;
    } else if (/light/.test(s)) {
        weight = 300;
    }
    const italic = /italic|oblique/.test(s);
    return { weight, style: italic ? "italic" : "normal" };
}

function parseText(layer: Layer, fonts: Map<string, FontDef>, variables?: LottieVariables): ParsedText | undefined {
    const doc = layer.t?.d?.k?.[0]?.s;
    if (!doc) {
        return undefined;
    }
    const def = fonts.get(doc.f);
    const { weight, style } = fontWeightStyle(def, doc.f);
    const family = def?.fFamily?.split(",")[0]?.replace(/['"]/g, "").trim() || "sans-serif";
    const fc = doc.fc ?? [0, 0, 0];
    const size = doc.s ?? 16;
    const boxed = Array.isArray(doc.sz) && doc.sz[0] > 0;
    // Runtime localization: if the raw text EXACTLY matches a variable key, substitute its value
    // (whole-string match, mirroring the original Babylon.js player). `hasOwnProperty` guards against
    // inherited keys (e.g. a placeholder literally named "toString") and preserves empty-string values.
    const raw = doc.t ?? "";
    const text = variables && Object.prototype.hasOwnProperty.call(variables, raw) ? variables[raw] : raw;
    return {
        text,
        family,
        weight,
        style,
        size,
        color: [fc[0], fc[1], fc[2], 1],
        justify: doc.j ?? 0,
        // Lottie tracking is 1/1000 em; convert to px letter spacing.
        letterSpacing: ((doc.tr ?? 0) / 1000) * size,
        lineHeight: doc.lh ?? size * 1.2,
        boxW: boxed ? doc.sz![0] : undefined,
        boxH: boxed ? doc.sz![1] : undefined,
        boxX: boxed && doc.ps ? doc.ps[0] : undefined,
        boxY: boxed && doc.ps ? doc.ps[1] : undefined,
    };
}

/** Build a static (non-animated) property holding a constant value. */
function staticProp(value: unknown): Prop {
    return { a: 0, k: value };
}

/** Parse a hex color string (#rgb / #rrggbb) into [r,g,b,a] in 0–1. */
function parseHexColor(hex: string): [number, number, number, number] {
    let h = hex.replace("#", "");
    if (h.length === 3) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

/** Synthesize a draw op for a solid layer: a `sw`×`sh` rect (top-left origin) filled with `sc`. */
function solidLayerOp(layer: Layer): DrawOp {
    const w = layer.sw ?? 0;
    const h = layer.sh ?? 0;
    const color = parseHexColor(layer.sc ?? "#000000");
    return {
        // Rect centered at (w/2, h/2) so its top-left is the layer origin (Lottie solid convention).
        contours: [{ rect: { p: staticProp([w / 2, h / 2]), s: staticProp([w, h]) } }],
        transforms: [],
        paint: { kind: "solid", color: staticProp(color) },
    };
}

/** Parse a layer's `masksProperties` into a flat list. Masks with no path are skipped. Returns
 *  undefined when the layer has no masks (so the renderer can skip the masked path entirely). */
function parseMasks(layer: Layer): ParsedMask[] | undefined {
    const raw = layer.masksProperties;
    if (!Array.isArray(raw) || raw.length === 0) {
        return undefined;
    }
    const masks: ParsedMask[] = [];
    for (const m of raw) {
        if (!m.pt) {
            continue;
        }
        masks.push({ mode: m.mode ?? "a", inverted: !!m.inv, path: m.pt, opacity: m.o });
    }
    return masks.length > 0 ? masks : undefined;
}

function parseLayer(layer: Layer, assetIndex: Map<string, number>, assets: ParsedAsset[], fonts: Map<string, FontDef>, variables?: LottieVariables): ParsedLayer {
    const ops: DrawOp[] = [];
    let image: ParsedImage | undefined;
    let text: ParsedText | undefined;
    if (layer.ty === 4 && layer.shapes) {
        walkGroup(layer.shapes, ops);
    } else if (layer.ty === 1) {
        // Solid layer: a full-size colored rectangle (rendered through the vector fill path).
        ops.push(solidLayerOp(layer));
    } else if (layer.ty === 2 && layer.refId !== undefined) {
        const idx = assetIndex.get(layer.refId);
        if (idx !== undefined) {
            image = { assetIndex: idx, width: assets[idx].width, height: assets[idx].height };
        }
    } else if (layer.ty === 5 && layer.t) {
        text = parseText(layer, fonts, variables);
    }
    return {
        // Solid layers (ty 1) render through the vector fill path, so report them as kind 4.
        kind: layer.hd ? 3 : layer.ty === 1 ? 4 : layer.ty,
        ind: layer.ind,
        parent: layer.parent,
        name: layer.nm ?? "",
        transform: layer.ks,
        ip: layer.ip,
        op: layer.op,
        st: layer.st ?? 0,
        ops,
        image,
        text,
        masks: parseMasks(layer),
        matteMode: layer.tt,
        matteOnly: !!layer.td || !!layer.hd,
    };
}

function parseAssets(raw: Asset[] | undefined): ParsedAsset[] {
    const assets: ParsedAsset[] = [];
    for (const a of raw ?? []) {
        assets.push({
            id: a.id,
            width: a.w ?? 0,
            height: a.h ?? 0,
            src: (a.u ?? "") + (a.p ?? ""),
        });
    }
    return assets;
}

/** Parse a Lottie document into a flat draw list. Keeps shape (`ty 4`), image (`ty 2`),
 *  text (`ty 5`), and null (`ty 3`, transform-only) layers. `variables` applies runtime text
 *  substitution to text layers (whole-string key match) — see {@link LottieVariables}. */
export function parseAnimation(file: LottieFile, variables?: LottieVariables): ParsedAnimation {
    const assets = parseAssets(file.assets);
    const assetIndex = new Map<string, number>();
    for (let i = 0; i < assets.length; i++) {
        assetIndex.set(assets[i].id, i);
    }
    const fonts = new Map<string, FontDef>();
    for (const f of file.fonts?.list ?? []) {
        fonts.set(f.fName, f);
    }
    const layers: ParsedLayer[] = [];
    const parsedByInd = new Map<number, ParsedLayer>();
    // Keep the layer kinds the renderers handle: shape (4, with shapes), solid (1), image (2, with a
    // refId), text (5, with a doc), and null (3, kept so children can resolve it as a transform parent).
    // parseLayer dispatches on the same kinds, so one filter here avoids duplicating that logic.
    for (const layer of file.layers) {
        if ((layer.ty === 4 && layer.shapes) || layer.ty === 1 || (layer.ty === 2 && layer.refId !== undefined) || (layer.ty === 5 && layer.t) || layer.ty === 3) {
            const parsed = parseLayer(layer, assetIndex, assets, fonts, variables);
            layers.push(parsed);
            parsedByInd.set(parsed.ind, parsed);
        }
    }
    for (let i = 0; i < file.layers.length; i++) {
        const layer = file.layers[i];
        if (!layer.tt) {
            continue;
        }
        const consumer = parsedByInd.get(layer.ind);
        const source = parsedByInd.get(layer.tp ?? file.layers[i - 1]?.ind);
        if (consumer && source) {
            consumer.matteSource = source.ind;
            source.matteOnly = true;
        }
    }
    return { width: file.w, height: file.h, ip: file.ip, op: file.op, fr: file.fr, layers, assets };
}
