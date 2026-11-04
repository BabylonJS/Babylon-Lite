import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installWebAudioMock, uninstallWebAudioMock, installDomMock, uninstallDomMock, MockAudioContext, type MockDocument, type MockDomElement } from "./web-audio-mock.js";
import { createAudioEngineAsync, disposeAudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";
import { createUnmuteUI, setUnmuteUIEnabled, disposeUnmuteUI } from "../../../../packages/babylon-lite/src/audio/unmute-ui.js";

async function makeEngine(state: "running" | "suspended" = "suspended") {
    const ctx = new MockAudioContext();
    ctx._setState(state);
    return createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
}

const button = (doc: MockDocument): MockDomElement => doc.body.children.find((c) => (c as MockDomElement).tagName === "button") as MockDomElement;

describe("unmute UI", () => {
    let doc: MockDocument;

    beforeEach(() => {
        installWebAudioMock();
        doc = installDomMock();
    });
    afterEach(() => {
        uninstallDomMock();
        uninstallWebAudioMock();
    });

    it("mounts a button and style and shows the button when not running", async () => {
        const engine = await makeEngine("suspended");
        const ui = createUnmuteUI(engine);

        const btn = button(doc);
        expect(btn).toBeDefined();
        expect(btn.className).toBe("babylonUnmute");
        expect(btn.id).toBe("babylonUnmuteButton");
        expect(btn.style.display).toBe("block");
        // A <style> was appended to the head.
        expect(doc.head.children.length).toBe(1);
        disposeUnmuteUI(ui);
        disposeAudioEngine(engine);
    });

    it("hides the button when the engine is already running", async () => {
        const engine = await makeEngine("running");
        const ui = createUnmuteUI(engine);
        expect(button(doc).style.display).toBe("none");
        disposeUnmuteUI(ui);
        disposeAudioEngine(engine);
    });

    it("unlocks the engine when the button is clicked", async () => {
        const engine = await makeEngine("suspended");
        const ui = createUnmuteUI(engine);

        const ctx = engine._ctx as unknown as MockAudioContext;
        let resumed = false;
        const orig = ctx.resume.bind(ctx);
        ctx.resume = async () => {
            resumed = true;
            return orig();
        };

        button(doc).fire("click");
        await Promise.resolve();
        expect(resumed).toBe(true);
        disposeUnmuteUI(ui);
        disposeAudioEngine(engine);
    });

    it("hides the button when the engine transitions to running", async () => {
        const engine = await makeEngine("suspended");
        const ui = createUnmuteUI(engine);
        expect(button(doc).style.display).toBe("block");

        (engine._ctx as unknown as MockAudioContext)._setState("running");
        expect(button(doc).style.display).toBe("none");
        disposeUnmuteUI(ui);
        disposeAudioEngine(engine);
    });

    it("setUnmuteUIEnabled toggles visibility", async () => {
        const engine = await makeEngine("suspended");
        const ui = createUnmuteUI(engine);

        setUnmuteUIEnabled(ui, false);
        expect(button(doc).style.display).toBe("none");
        setUnmuteUIEnabled(ui, true);
        expect(button(doc).style.display).toBe("block");
        disposeUnmuteUI(ui);
        disposeAudioEngine(engine);
    });

    it("disposeUnmuteUI removes DOM nodes and unsubscribes", async () => {
        const engine = await makeEngine("suspended");
        const ui = createUnmuteUI(engine);
        const btn = button(doc);
        const styleEl = doc.head.children[0] as MockDomElement;

        disposeUnmuteUI(ui);

        expect(btn.removed).toBe(true);
        expect(styleEl.removed).toBe(true);
        expect(ui._button).toBeNull();
        expect(ui._style).toBeNull();
        expect(ui._unsub).toBeNull();

        // State changes after dispose do not throw.
        (engine._ctx as unknown as MockAudioContext)._setState("running");
        disposeAudioEngine(engine);
    });
});
