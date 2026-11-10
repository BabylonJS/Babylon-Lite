import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createHtmlTexture,
    updateHtmlTexture,
    requestHtmlTextureUpdate,
    disposeHtmlTexture,
    isHtmlInCanvasSupported,
    whenHtmlTextureReady,
} from "../../../packages/babylon-lite/src/texture/html-texture";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

/** A minimal fake DOM element implementing only what html-texture touches.
 *  Constructed structurally, then surfaced to the API as an `HTMLElement`. */
interface FakeElement {
    offsetWidth: number;
    offsetHeight: number;
    parentNode: Node | null;
    parentElement: Element | null;
    nextSibling: Node | null;
    inert: boolean;
    attributes: Map<string, string>;
    contains(other: unknown): boolean;
    hasAttribute(name: string): boolean;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
}

function makeElement(width = 256, height = 128): HTMLElement {
    const el: FakeElement = {
        offsetWidth: width,
        offsetHeight: height,
        parentNode: null,
        parentElement: null,
        nextSibling: null,
        inert: false,
        attributes: new Map(),
        contains: (other) => other === (el as unknown),
        hasAttribute: (name) => el.attributes.has(name),
        setAttribute: (name, value) => {
            el.attributes.set(name, value);
        },
        removeAttribute: (name) => {
            el.attributes.delete(name);
        },
    };
    return el as unknown as HTMLElement;
}

/** Reveal the writable structural view of a fake element for test setup. */
function writable(el: HTMLElement): FakeElement {
    return el as unknown as FakeElement;
}

interface FakeHost {
    clientWidth: number;
    content?: string;
    layoutSubtree?: boolean;
    requestPaint?: () => void;
    paintRequests: number;
    children: HTMLElement[];
    listeners: Record<string, Array<(ev: Event) => void>>;
    addEventListener(type: string, cb: (ev: Event) => void): void;
    removeEventListener(type: string, cb: (ev: Event) => void): void;
    appendChild(el: HTMLElement): HTMLElement;
    removeChild(el: HTMLElement): void;
    insertBefore(el: HTMLElement, ref: Node | null): void;
    attributes: Map<string, string>;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    dispatchPaint(changedElements?: readonly unknown[]): void;
}

/** Fake rendering canvas. `clientWidth` makes `isDomCanvas` return true.
 *  `requestPaint` synchronously dispatches a `paint` event for deterministic tests.
 *  `legacy` models a Chrome < 155 canvas (`layoutSubtree`) instead of `content`. */
function makeHost(opts: { withRequestPaint?: boolean; legacy?: boolean } = {}): FakeHost {
    const host: FakeHost = {
        clientWidth: 800,
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
            writable(el).parentElement = this as unknown as Element;
            this.children.push(el);
            return el;
        },
        removeChild(el) {
            writable(el).parentNode = null;
            writable(el).parentElement = null;
            const i = this.children.indexOf(el);
            if (i >= 0) {
                this.children.splice(i, 1);
            }
        },
        insertBefore(el) {
            writable(el).parentNode = this as unknown as Node;
            writable(el).parentElement = this as unknown as Element;
        },
        attributes: new Map(),
        getAttribute(name) {
            return this.attributes.get(name) ?? null;
        },
        setAttribute(name, value) {
            this.attributes.set(name, value);
        },
        removeAttribute(name) {
            this.attributes.delete(name);
        },
        dispatchPaint(changedElements) {
            const ev = { type: "paint", changedElements } as unknown as Event;
            (this.listeners.paint ?? []).slice().forEach((cb) => cb(ev));
        },
    };
    if (opts.legacy) {
        host.layoutSubtree = false;
    } else {
        // Chrome 155+ reflects the `content` attribute; a missing attribute reads "fallback".
        Object.defineProperty(host, "content", {
            enumerable: true,
            get: () => host.attributes.get("content") ?? "fallback",
            set: (value: string) => host.attributes.set("content", value),
        });
    }
    if (opts.withRequestPaint ?? true) {
        host.requestPaint = (): void => {
            host.paintRequests++;
            host.dispatchPaint();
        };
    }
    return host;
}

interface Captured {
    copyElementCalls: Array<{ api: "draw" | "legacy"; source: unknown; texture: GPUTexture; width?: number; height?: number }>;
    copyExternalCalls: number;
    blitBindGroups: number;
    blitPasses: number;
    submits: number;
    createDesc?: GPUTextureDescriptor;
    destroyed: boolean;
}

/** `native`: `"draw"` (Chrome 155+ `drawElementImageToTexture`), `"legacy"`
 *  (Chrome 150–154 `copyElementImageToTexture`), or `false` (unsupported). */
function makeEngine(host: FakeHost, cap: Captured, opts: { native?: "draw" | "legacy" | false } = {}): EngineContext {
    const native = opts.native ?? "draw";
    const queue: Record<string, unknown> = {
        copyExternalImageToTexture: () => {
            cap.copyExternalCalls++;
        },
        submit: () => {
            cap.submits++;
        },
    };
    if (native === "draw") {
        queue.drawElementImageToTexture = (source: { source: unknown }, dest: { texture: GPUTexture; size: { width: number; height: number } }) => {
            cap.copyElementCalls.push({ api: "draw", source: source.source, texture: dest.texture, width: dest.size.width, height: dest.size.height });
        };
    } else if (native === "legacy") {
        queue.copyElementImageToTexture = (source: { source: unknown }, dest: { destination: { texture: GPUTexture }; width?: number; height?: number }) => {
            cap.copyElementCalls.push({ api: "legacy", source: source.source, texture: dest.destination.texture, width: dest.width, height: dest.height });
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
    it("reflects presence of drawElementImageToTexture or the legacy copyElementImageToTexture", () => {
        expect(isHtmlInCanvasSupported(makeEngine(makeHost(), newCap(), { native: "draw" }))).toBe(true);
        expect(isHtmlInCanvasSupported(makeEngine(makeHost(), newCap(), { native: "legacy" }))).toBe(true);
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
        // Element re-parented under the host with drawable content opted in and inert set.
        expect(host.content).toBe("drawable");
        expect(host.layoutSubtree).toBeUndefined();
        expect(host.children).toContain(el);
        expect(el.hasAttribute("drawable")).toBe(true);
        expect(el.inert).toBe(true);
        // requestPaint fired once, and the paint uploaded via drawElementImageToTexture.
        expect(host.paintRequests).toBe(1);
        expect(cap.copyElementCalls).toHaveLength(1);
        expect(cap.copyElementCalls[0]!.api).toBe("draw");
        expect(cap.copyElementCalls[0]!.source).toBe(el);
        expect(cap.copyElementCalls[0]!.width).toBe(200);
        expect(cap.copyElementCalls[0]!.height).toBe(100);
        // Upright default → capture staged and V-flipped into the final texture (baked, not material-side).
        expect(cap.copyElementCalls[0]!.texture).toBe(tex._flipSrc);
        expect(cap.blitPasses).toBe(1);
        expect(cap.submits).toBe(1);
    });

    it("resolves readiness only after the first successful paint upload", async () => {
        const host = makeHost({ withRequestPaint: false });
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const tex = createHtmlTexture(engine, makeElement(), {});
        let ready = false;
        void whenHtmlTextureReady(tex).then(() => {
            ready = true;
        });

        await Promise.resolve();
        expect(ready).toBe(false);
        host.dispatchPaint();
        await whenHtmlTextureReady(tex);
        expect(ready).toBe(true);
    });

    it("keeps readiness pending after a transient native upload failure and resolves after retry", async () => {
        const host = makeHost({ withRequestPaint: false });
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const queue = engine._device.queue as unknown as { drawElementImageToTexture: () => void };
        const failure = new Error("native upload failed");
        queue.drawElementImageToTexture = (): void => {
            throw failure;
        };
        const tex = createHtmlTexture(engine, makeElement(), { invertY: false });
        const ready = whenHtmlTextureReady(tex);
        let settled = false;
        void ready.finally(() => {
            settled = true;
        });

        expect(() => host.dispatchPaint()).toThrow(failure);
        await Promise.resolve();
        expect(settled).toBe(false);

        queue.drawElementImageToTexture = (): void => {
            cap.copyExternalCalls++;
        };
        host.dispatchPaint();
        await ready;
        expect(settled).toBe(true);
        expect(cap.copyExternalCalls).toBe(1);
    });

    it("uses the legacy copyElementImageToTexture and layoutSubtree on Chrome 150–154", () => {
        const host = makeHost({ legacy: true });
        const cap = newCap();
        const engine = makeEngine(host, cap, { native: "legacy" });
        const el = makeElement(200, 100);

        const tex = createHtmlTexture(engine, el, {});

        expect(host.layoutSubtree).toBe(true);
        expect(host.content).toBeUndefined();
        expect(cap.copyElementCalls).toHaveLength(1);
        expect(cap.copyElementCalls[0]!.api).toBe("legacy");
        expect(cap.copyElementCalls[0]!.texture).toBe(tex._flipSrc);
        expect(cap.copyElementCalls[0]!.width).toBe(200);
        expect(cap.copyElementCalls[0]!.height).toBe(100);

        disposeHtmlTexture(tex);
        expect(host.layoutSubtree).toBe(false);
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

    it("recreates the flip staging texture when the GPU device changes (device-lost recovery)", () => {
        const host = makeHost();
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const tex = createHtmlTexture(engine, makeElement(32, 32), { autoUpdate: true });
        const firstSrc = tex._flipSrc;
        expect(firstSrc).not.toBeNull();
        expect(tex._flipDevice).toBe(engine._device);

        // Simulate device-lost recovery: the engine now exposes a brand-new GPUDevice
        // while the texture's cached staging texture still belongs to the dead device.
        const engine2 = makeEngine(host, cap);
        updateHtmlTexture(engine2, tex);

        // Staging texture rebuilt on the new device rather than blitting into a dead one.
        expect(tex._flipSrc).not.toBe(firstSrc);
        expect(tex._flipDevice).toBe(engine2._device);
        expect(cap.copyElementCalls.at(-1)!.texture).toBe(tex._flipSrc);
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
        expect(el.hasAttribute("drawable")).toBe(false); // drawable restored
        expect(host.listeners.paint ?? []).toHaveLength(0); // listener detached

        // Further paints / updates are inert after dispose.
        const count = cap.copyElementCalls.length;
        host.dispatchPaint([el]);
        updateHtmlTexture(engine, tex);
        requestHtmlTextureUpdate(engine, tex);
        expect(cap.copyElementCalls).toHaveLength(count);
    });

    it("rejects pending readiness and cannot upload after disposal", async () => {
        const host = makeHost({ withRequestPaint: false });
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const tex = createHtmlTexture(engine, makeElement(), {});
        const ready = whenHtmlTextureReady(tex);

        disposeHtmlTexture(tex);
        host.dispatchPaint();

        await expect(ready).rejects.toThrow(/disposed before its first upload/);
        expect(cap.copyElementCalls).toHaveLength(0);
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

    it("restores an element a polyfill relocated into a sibling host element", () => {
        // @underglass/html-in-canvas-polyfill moves canvas children into a sibling
        // `div[data-hic-host]` but keeps reporting the canvas as their parentElement.
        const relocate = (el: HTMLElement, relocatedHost: { removeChild(child: unknown): void }): void => {
            writable(el).parentNode = relocatedHost as unknown as Node;
        };

        const host = makeHost();
        const engine = makeEngine(host, newCap());
        const el = makeElement();
        const origParent = { insertBefore: vi.fn(), removeChild: vi.fn() };
        writable(el).parentNode = origParent as unknown as Node;
        const tex = createHtmlTexture(engine, el, {});
        relocate(el, { removeChild: vi.fn() });
        disposeHtmlTexture(tex);
        expect(origParent.insertBefore).toHaveBeenCalledWith(el, null);

        const detached = makeElement();
        const relocatedHost = { removeChild: vi.fn() };
        const tex2 = createHtmlTexture(engine, detached, {});
        relocate(detached, relocatedHost);
        disposeHtmlTexture(tex2);
        expect(relocatedHost.removeChild).toHaveBeenCalledWith(detached);
    });

    it("detaches a form whose named control shadows Element.remove", () => {
        const host = makeHost();
        const removeChild = vi.spyOn(host, "removeChild");
        const engine = makeEngine(host, newCap());
        // `<form><button name="remove"></button></form>` exposes the button as `form.remove`.
        const form = makeElement();
        (form as unknown as { remove: unknown }).remove = { name: "remove" };
        const tex = createHtmlTexture(engine, form, {});
        expect(form.inert).toBe(true);

        expect(() => disposeHtmlTexture(tex)).not.toThrow();
        expect(removeChild).toHaveBeenCalledWith(form);
        expect(form.parentNode).toBeNull();
        expect(form.inert).toBe(false);
        expect(form.hasAttribute("drawable")).toBe(false);
    });

    it("keeps a drawable attribute the element already had", () => {
        const host = makeHost();
        const engine = makeEngine(host, newCap());
        const el = makeElement();
        el.setAttribute("drawable", "");

        disposeHtmlTexture(createHtmlTexture(engine, el, {}));
        expect(el.hasAttribute("drawable")).toBe(true);
    });

    it("is idempotent", () => {
        const host = makeHost();
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const tex = createHtmlTexture(engine, makeElement(), {});
        disposeHtmlTexture(tex);
        expect(() => disposeHtmlTexture(tex)).not.toThrow();
    });

    it("restores host.content once the last hosted texture on it is disposed", () => {
        const host = makeHost();
        const engine = makeEngine(host, newCap());
        expect(host.content).toBe("fallback");

        const a = createHtmlTexture(engine, makeElement(), {});
        const b = createHtmlTexture(engine, makeElement(), {});
        expect(host.content).toBe("drawable");

        disposeHtmlTexture(a);
        expect(host.content).toBe("drawable"); // still one live texture on the host

        disposeHtmlTexture(b);
        expect(host.content).toBe("fallback"); // restored to the pre-feature value
        expect(host.attributes.has("content")).toBe(false); // no attribute left behind
    });

    it("restores a content attribute the canvas already had", () => {
        const host = makeHost();
        host.setAttribute("content", "fallback");
        const engine = makeEngine(host, newCap());

        disposeHtmlTexture(createHtmlTexture(engine, makeElement(), {}));
        expect(host.getAttribute("content")).toBe("fallback");
    });

    it("keeps a shared element hosted until the last texture using it is disposed", () => {
        const host = makeHost();
        const cap = newCap();
        const engine = makeEngine(host, cap);
        const el = makeElement();
        const origParent = {
            insertBefore: vi.fn(),
            removeChild: vi.fn(),
        };
        writable(el).parentNode = origParent as unknown as Node;

        const a = createHtmlTexture(engine, el, {});
        const b = createHtmlTexture(engine, el, {});
        disposeHtmlTexture(a);

        // The second texture still captures the element.
        expect(el.parentNode).toBe(host as unknown as Node);
        expect(el.hasAttribute("drawable")).toBe(true);
        expect(el.inert).toBe(true);
        expect(origParent.insertBefore).not.toHaveBeenCalled();
        const count = cap.copyElementCalls.length;
        host.dispatchPaint([el]);
        expect(cap.copyElementCalls.length).toBeGreaterThan(count);

        disposeHtmlTexture(b);
        expect(origParent.insertBefore).toHaveBeenCalledWith(el, null);
        expect(el.hasAttribute("drawable")).toBe(false);
        expect(el.inert).toBe(false);
    });

    it("rejects sharing an element with a texture on another canvas", () => {
        const hostA = makeHost();
        const hostB = makeHost();
        const capB = newCap();
        const engineA = makeEngine(hostA, newCap());
        const engineB = makeEngine(hostB, capB);
        const el = makeElement();

        const a = createHtmlTexture(engineA, el, {});
        expect(() => createHtmlTexture(engineB, el, {})).toThrow(/another canvas/);

        // Nothing was allocated or opted in on canvas B.
        expect(capB.createDesc).toBeUndefined();
        expect(hostB.content).toBe("fallback");
        expect(hostB.attributes.has("content")).toBe(false);
        expect(hostB.listeners.paint ?? []).toHaveLength(0);
        expect(el.parentNode).toBe(hostA as unknown as Node);

        // Once canvas A releases the element, canvas B can host it.
        disposeHtmlTexture(a);
        const b = createHtmlTexture(engineB, el, {});
        expect(el.parentNode).toBe(hostB as unknown as Node);
        disposeHtmlTexture(b);
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

        const tex = createHtmlTexture(engine, makeElement(), { useSvgFallback: true });
        await whenHtmlTextureReady(tex);

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

        const tex = createHtmlTexture(engine, el, { useSvgFallback: false });
        await expect(whenHtmlTextureReady(tex)).rejects.toThrow(/no supported HTML upload path/);

        expect(cap.copyExternalCalls).toBe(0);
        // With no update path the element must not be hosted or the DOM mutated.
        expect(host.children).not.toContain(el);
        expect(host.content).toBe("fallback");
        expect(el.hasAttribute("drawable")).toBe(false);
        expect(writable(el).inert).toBe(false);
    });

    it("rejects readiness when SVG rasterisation fails", async () => {
        const g = globalThis as Record<string, unknown>;
        g.XMLSerializer = class {
            serializeToString(): string {
                return "<div>hi</div>";
            }
        };
        g.Image = class {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            set src(_value: string) {
                queueMicrotask(() => this.onerror?.());
            }
        };
        const tex = createHtmlTexture(makeEngine(makeHost({ withRequestPaint: false }), newCap(), { native: false }), makeElement(), { useSvgFallback: true });

        await expect(whenHtmlTextureReady(tex)).rejects.toThrow(/failed to rasterise/);
    });
});
