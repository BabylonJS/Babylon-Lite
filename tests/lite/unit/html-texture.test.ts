import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createHtmlTexture,
    updateHtmlTexture,
    requestHtmlTextureUpdate,
    disposeHtmlTexture,
    isHtmlInCanvasSupported,
} from "../../../packages/babylon-lite/src/texture/html-texture";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

/** A minimal fake DOM element implementing only what html-texture touches.
 *  Constructed structurally, then surfaced to the API as an `HTMLElement`. */
interface FakeElement {
    offsetWidth: number;
    offsetHeight: number;
    parentNode: Node | null;
    nextSibling: Node | null;
    inert: boolean;
    contains(other: unknown): boolean;
}

function makeElement(width = 256, height = 128): HTMLElement {
    const el: FakeElement = {
        offsetWidth: width,
        offsetHeight: height,
        parentNode: null,
        nextSibling: null,
        inert: false,
        contains: (other) => other === (el as unknown),
    };
    return el as unknown as HTMLElement;
}

/** Reveal the writable structural view of a fake element for test setup. */
function writable(el: HTMLElement): FakeElement {
    return el as unknown as FakeElement;
}

interface FakeHost {
    clientWidth: number;
    layoutSubtree: boolean;
    requestPaint?: () => void;
    paintRequests: number;
    children: HTMLElement[];
    listeners: Record<string, Array<(ev: Event) => void>>;
    addEventListener(type: string, cb: (ev: Event) => void): void;
    removeEventListener(type: string, cb: (ev: Event) => void): void;
    appendChild(el: HTMLElement): HTMLElement;
    removeChild(el: HTMLElement): void;
    insertBefore(el: HTMLElement, ref: Node | null): void;
    dispatchPaint(changedElements?: readonly unknown[]): void;
}

/** Fake rendering canvas. `clientWidth` makes `isDomCanvas` return true.
 *  `requestPaint` synchronously dispatches a `paint` event for deterministic tests. */
function makeHost(opts: { withRequestPaint?: boolean } = {}): FakeHost {
    const host: FakeHost = {
        clientWidth: 800,
        layoutSubtree: false,
        paintRequests: 0,
        children: [],
        listeners: {},
        addEventListener(type, cb) {
            (this.listeners[type] ??= []).push(cb);
        },
        removeEventListener(type, cb) {
            const arr = this.listeners[type];
            if (arr) {
                const i = arr.indexOf(cb);
                if (i >= 0) {
                    arr.splice(i, 1);
                }
            }
        },
        appendChild(el) {
            writable(el).parentNode = this as unknown as Node;
            this.children.push(el);
            return el;
        },
        removeChild(el) {
            writable(el).parentNode = null;
            const i = this.children.indexOf(el);
            if (i >= 0) {
                this.children.splice(i, 1);
            }
        },
        insertBefore(el) {
            writable(el).parentNode = this as unknown as Node;
        },
        dispatchPaint(changedElements) {
            const ev = { type: "paint", changedElements } as unknown as Event;
            (this.listeners.paint ?? []).slice().forEach((cb) => cb(ev));
        },
    };
    if (opts.withRequestPaint ?? true) {
        host.requestPaint = (): void => {
            host.paintRequests++;
            host.dispatchPaint();
        };
    }
    return host;
}

interface Captured {
    copyElementCalls: Array<{ source: unknown; texture: GPUTexture; width?: number; height?: number }>;
    copyExternalCalls: number;
    blitBindGroups: number;
    blitPasses: number;
    submits: number;
    createDesc?: GPUTextureDescriptor;
    destroyed: boolean;
}

function makeEngine(host: FakeHost, cap: Captured, opts: { native?: boolean } = {}): EngineContext {
    const native = opts.native ?? true;
    const queue: Record<string, unknown> = {
        copyExternalImageToTexture: () => {
            cap.copyExternalCalls++;
        },
        submit: () => {
            cap.submits++;
        },
    };
    if (native) {
        queue.copyElementImageToTexture = (source: { source: unknown }, dest: { destination: { texture: GPUTexture }; width?: number; height?: number }) => {
            cap.copyElementCalls.push({ source: source.source, texture: dest.destination.texture, width: dest.width, height: dest.height });
        };
    }
    const device = {
        createTexture: (desc: GPUTextureDescriptor) => {
            cap.createDesc = desc;
            return {
                width: (desc.size as { width: number }).width,
                height: (desc.size as { height: number }).height,
                format: desc.format,
                mipLevelCount: desc.mipLevelCount ?? 1,
                createView: () => ({ _kind: "view" }),
                destroy: () => {
                    cap.destroyed = true;
                },
            } as unknown as GPUTexture;
        },
        createSampler: () => ({ _kind: "sampler" }) as unknown as GPUSampler,
        // Minimal render-pipeline surface exercised by the native V-flip blit.
        createShaderModule: () => ({ _kind: "shader" }),
        createBindGroupLayout: () => ({ _kind: "bgl" }),
        createPipelineLayout: () => ({ _kind: "pl" }),
        createRenderPipeline: () => ({ _kind: "pipeline" }),
        createBindGroup: () => {
            cap.blitBindGroups++;
            return { _kind: "bindgroup" };
        },
        createCommandEncoder: () => ({
            beginRenderPass: () => {
                cap.blitPasses++;
                return { setPipeline: () => {}, setBindGroup: () => {}, draw: () => {}, end: () => {} };
            },
            finish: () => ({ _kind: "cmd" }),
        }),
        queue,
    };
    return {
        _device: device as unknown as GPUDevice,
        surfaces: [{ canvas: host as unknown as HTMLCanvasElement }],
    } as unknown as EngineContext;
}

function newCap(): Captured {
    return { copyElementCalls: [], copyExternalCalls: 0, blitBindGroups: 0, blitPasses: 0, submits: 0, destroyed: false };
}

afterEach(() => {
    delete (globalThis as Record<string, unknown>).XMLSerializer;
    delete (globalThis as Record<string, unknown>).Image;
    delete (globalThis as Record<string, unknown>).document;
});

describe("isHtmlInCanvasSupported", () => {
    it("reflects presence of copyElementImageToTexture on the device queue", () => {
        expect(isHtmlInCanvasSupported(makeEngine(makeHost(), newCap(), { native: true }))).toBe(true);
        expect(isHtmlInCanvasSupported(makeEngine(makeHost(), newCap(), { native: false }))).toBe(false);
    });
});

describe("createHtmlTexture (native path)", () => {
    it("defaults size from the element, hosts it, and uploads on the first paint", () => {
        const host = makeHost();
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const el = makeElement(200, 100);

        const tex = createHtmlTexture(engine, el, {});

        expect(tex.width).toBe(200);
        expect(tex.height).toBe(100);
        // Element re-parented under the host with layout opted in and inert set.
        expect(host.layoutSubtree).toBe(true);
        expect(host.children).toContain(el);
        expect(el.inert).toBe(true);
        // requestPaint fired once, and the paint uploaded via copyElementImageToTexture.
        expect(host.paintRequests).toBe(1);
        expect(cap.copyElementCalls).toHaveLength(1);
        expect(cap.copyElementCalls[0]!.source).toBe(el);
        expect(cap.copyElementCalls[0]!.width).toBe(200);
        expect(cap.copyElementCalls[0]!.height).toBe(100);
        // Upright default → capture staged and V-flipped into the final texture (baked, not material-side).
        expect(cap.copyElementCalls[0]!.texture).toBe(tex._flipSrc);
        expect(cap.blitPasses).toBe(1);
        expect(cap.submits).toBe(1);
    });

    it("copies straight into the texture (no flip blit) when invertY:false", () => {
        const host = makeHost();
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const tex = createHtmlTexture(engine, makeElement(10, 10), { width: 64, height: 32, invertY: false });
        expect(tex.width).toBe(64);
        expect(tex.height).toBe(32);
        // invertY:false keeps the native top-row-first orientation → direct copy, no staging/blit.
        expect(cap.copyElementCalls[0]!.texture).toBe(tex.texture);
        expect(tex._flipSrc).toBeNull();
        expect(cap.blitPasses).toBe(0);
    });

    it("falls back to 256 when the element reports zero size and no override is given", () => {
        const host = makeHost();
        const engine = makeEngine(host, newCap());
        const tex = createHtmlTexture(engine, makeElement(0, 0), {});
        expect(tex.width).toBe(256);
        expect(tex.height).toBe(256);
    });

    it("auto-updates only when the hosted element is among changedElements", () => {
        const host = makeHost();
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const el = makeElement();
        createHtmlTexture(engine, el, { autoUpdate: true });
        expect(cap.copyElementCalls).toHaveLength(1); // initial

        const other = makeElement();
        host.dispatchPaint([other]); // unrelated change → skipped
        expect(cap.copyElementCalls).toHaveLength(1);

        host.dispatchPaint([el]); // our element changed → uploaded
        expect(cap.copyElementCalls).toHaveLength(2);
    });

    it("does not auto-update on incidental paints when autoUpdate is false", () => {
        const host = makeHost();
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const el = makeElement();
        const tex = createHtmlTexture(engine, el, { autoUpdate: false });
        const initial = cap.copyElementCalls.length;

        host.dispatchPaint([el]); // ignored: autoUpdate off, not force-requested
        expect(cap.copyElementCalls).toHaveLength(initial);

        // Explicit request forces the next paint to upload regardless of the filter.
        requestHtmlTextureUpdate(engine, tex);
        expect(cap.copyElementCalls).toHaveLength(initial + 1);
    });
});

describe("requestHtmlTextureUpdate", () => {
    it("schedules a paint on the native path", () => {
        const host = makeHost();
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const tex = createHtmlTexture(engine, makeElement(), { autoUpdate: true });
        const before = host.paintRequests;
        requestHtmlTextureUpdate(engine, tex);
        expect(host.paintRequests).toBe(before + 1);
        expect(cap.copyElementCalls.length).toBeGreaterThanOrEqual(2);
    });
});

describe("disposeHtmlTexture", () => {
    it("detaches the paint listener, restores the element, and releases the texture", () => {
        const host = makeHost();
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const el = makeElement();
        const tex = createHtmlTexture(engine, el, { autoUpdate: true });

        disposeHtmlTexture(tex);

        expect(cap.destroyed).toBe(true); // GPU texture freed (creation ref → 0)
        expect(host.children).not.toContain(el); // element removed from host
        expect(el.inert).toBe(false); // inert restored
        expect(host.listeners.paint ?? []).toHaveLength(0); // listener detached

        // Further paints / updates are inert after dispose.
        const count = cap.copyElementCalls.length;
        host.dispatchPaint([el]);
        updateHtmlTexture(engine, tex);
        requestHtmlTextureUpdate(engine, tex);
        expect(cap.copyElementCalls).toHaveLength(count);
    });

    it("restores the element to its original parent when it had one", () => {
        const host = makeHost();
        const engine = makeEngine(host, newCap());
        const el = makeElement();
        const origParent = {
            insertBefore: vi.fn(),
            removeChild: vi.fn(),
        };
        writable(el).parentNode = origParent as unknown as Node;

        const tex = createHtmlTexture(engine, el, {});
        disposeHtmlTexture(tex);
        expect(origParent.insertBefore).toHaveBeenCalledWith(el, null);
    });

    it("is idempotent", () => {
        const host = makeHost();
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const tex = createHtmlTexture(engine, makeElement(), {});
        disposeHtmlTexture(tex);
        expect(() => disposeHtmlTexture(tex)).not.toThrow();
    });

    it("restores host.layoutSubtree once the last hosted texture on it is disposed", () => {
        const host = makeHost();
        const engine = makeEngine(host, newCap());
        expect(host.layoutSubtree).toBe(false);

        const a = createHtmlTexture(engine, makeElement(), {});
        const b = createHtmlTexture(engine, makeElement(), {});
        expect(host.layoutSubtree).toBe(true);

        disposeHtmlTexture(a);
        expect(host.layoutSubtree).toBe(true); // still one live texture on the host

        disposeHtmlTexture(b);
        expect(host.layoutSubtree).toBe(false); // restored to the pre-feature value
    });
});

describe("createHtmlTexture (no DOM canvas)", () => {
    it("throws when the rendering surface is an OffscreenCanvas", () => {
        const cap = newCap();
        // An OffscreenCanvas-like host lacks `clientWidth`, so isDomCanvas is false.
        const offscreen = { layoutSubtree: false } as unknown as FakeHost;
        const engine = makeEngine(offscreen, cap);
        expect(() => createHtmlTexture(engine, makeElement(), {})).toThrow(/DOM canvas/);
    });
});

describe("SVG fallback path", () => {
    /** Stub XMLSerializer + Image so the fallback can run under the node env. */
    function installSvgStubs(): void {
        const g = globalThis as Record<string, unknown>;
        g.XMLSerializer = class {
            serializeToString(): string {
                return "<div>hi</div>";
            }
        };
        g.Image = class {
            decoding = "";
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            constructor(
                public width?: number,
                public height?: number
            ) {}
            set src(_v: string) {
                // Resolve asynchronously like a real decode.
                queueMicrotask(() => this.onload?.());
            }
        };
        // The fallback rasterises the decoded SVG onto a 2D canvas before upload.
        g.document = {
            createElement: (_tag: string) => ({
                width: 0,
                height: 0,
                getContext: (_id: string) => ({ drawImage: (): void => {} }),
            }),
        };
    }

    it("rasterises a static snapshot via updateDynamicTexture when native is unavailable", async () => {
        installSvgStubs();
        const host = makeHost({ withRequestPaint: false });
        const cap = newCap();
        const engine = makeEngine(host, cap, { native: false });

        createHtmlTexture(engine, makeElement(), { useSvgFallback: true });
        await new Promise((r) => setTimeout(r, 0));

        // No native copy; the fallback uploaded through copyExternalImageToTexture.
        expect(cap.copyElementCalls).toHaveLength(0);
        expect(cap.copyExternalCalls).toBe(1);
    });

    it("does nothing when native is unavailable and useSvgFallback is false", async () => {
        installSvgStubs();
        const host = makeHost({ withRequestPaint: false });
        const cap = newCap();
        const engine = makeEngine(host, cap, { native: false });
        const el = makeElement();

        createHtmlTexture(engine, el, { useSvgFallback: false });
        await new Promise((r) => setTimeout(r, 0));

        expect(cap.copyExternalCalls).toBe(0);
        // With no update path the element must not be hosted or the DOM mutated.
        expect(host.children).not.toContain(el);
        expect(host.layoutSubtree).toBe(false);
        expect(writable(el).inert).toBe(false);
    });
});
