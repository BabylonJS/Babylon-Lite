import { expect, test } from "@playwright/test";
import type { DeviceInputFixture } from "../../../lab/lite/src/device-input";

declare global {
    interface Window {
        deviceInputFixture: DeviceInputFixture;
    }
}
const baseURL = `http://localhost:${process.env.LAB_TEST_PORT ?? 5179}`;
test.beforeEach(async ({ page }) => {
    await page.goto(`${baseURL}/lite/device-input.html`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("reads real keyboard, drag and wheel alongside camera controls", async ({ page }) => {
    const canvas = page.locator("#renderCanvas");
    await canvas.focus();
    await page.keyboard.down("w");
    await page.keyboard.down("Shift");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 60);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => page.evaluate(() => window.deviceInputFixture.state().wheelY)).toBe(120);
    const state = await page.evaluate(() => window.deviceInputFixture.state());
    expect(state.keys).toEqual(expect.arrayContaining(["KeyW", "ShiftLeft"]));
    expect([state.x, state.y, state.buttons]).toEqual([80, 60, 1]);
    expect(state.deltaX).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.deviceInputFixture.cameraMotion())).not.toBe(0);
    await page.evaluate(() => window.deviceInputFixture.reset());
    expect(await page.evaluate(() => window.deviceInputFixture.state().buttons)).toBe(1);
    expect(await page.evaluate(() => window.deviceInputFixture.state().deltaX)).toBe(0);
    await page.mouse.move(box.x + box.width + 30, box.y + 80);
    await page.mouse.up();
    await page.keyboard.up("w");
    await page.keyboard.up("Shift");
    expect(await page.evaluate(() => window.deviceInputFixture.state().buttons)).toBe(0);
    expect(await page.evaluate(() => window.deviceInputFixture.state().keys)).toEqual([]);
});

test("clears focus loss and detaches one observer without affecting another", async ({ page }) => {
    const canvas = page.locator("#renderCanvas");
    await canvas.focus();
    await page.keyboard.down("w");
    await page.locator("#editor").focus();
    expect(await page.evaluate(() => window.deviceInputFixture.state().keys)).toEqual([]);
    await page.keyboard.up("w");
    await page.evaluate(() => {
        window.deviceInputFixture.dispose();
        window.deviceInputFixture.dispose();
    });
    await canvas.focus();
    await page.keyboard.down("a");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    expect(await page.evaluate(() => window.deviceInputFixture.state().keys)).toEqual([]);
    expect(await page.evaluate(() => window.deviceInputFixture.state().buttons)).toBe(0);
    expect(await page.evaluate(() => window.deviceInputFixture.secondState().keys)).toContain("KeyA");
    expect(await page.evaluate(() => window.deviceInputFixture.secondState().buttons)).toBe(1);
    await page.mouse.up();
    await page.keyboard.up("a");
});

test("keeps iframe keyboard and CSS pointer coordinates in their own realm", async ({ page }) => {
    const canvas = page.frameLocator("#realm").locator("#frameCanvas");
    await canvas.click({ position: { x: 35, y: 40 } });
    await page.keyboard.down("w");
    const frameState = await page.evaluate(() => window.deviceInputFixture.frameState());
    expect(frameState.keys).toContain("KeyW");
    expect(frameState.x).toBeCloseTo(35, 1);
    expect(frameState.y).toBeCloseTo(40, 1);
    expect(await page.evaluate(() => window.deviceInputFixture.state().keys)).toEqual([]);
    await page.keyboard.up("w");
    expect(await page.evaluate(() => window.deviceInputFixture.frameState().keys)).toEqual([]);
});

test("handles actual touch identity, secondary contacts and cancellation", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    const box = (await page.locator("#renderCanvas").boundingBox())!;
    const first = { x: box.x + 30, y: box.y + 40, id: 1 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first] });
    const initial = await page.evaluate(() => window.deviceInputFixture.state());
    expect([initial.pointerType, initial.buttons]).toEqual(["touch", 1]);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first, { x: box.x + 100, y: box.y + 50, id: 2 }] });
    expect(await page.evaluate(() => window.deviceInputFixture.state().pointerId)).toBe(initial.pointerId);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    expect(await page.evaluate(() => window.deviceInputFixture.state().buttons)).toBe(0);
    expect(await page.evaluate(() => window.deviceInputFixture.state().pointerId)).toBeNull();
    await cdp.detach();
});

test("copies mocked browser gamepads and handles their disconnection", async ({ page }) => {
    const result = await page.evaluate(() => {
        const button = { value: 1, pressed: true, touched: true };
        const pad = { id: "fixture", index: 0, mapping: "standard", timestamp: 1, connected: true, axes: [0.5, -0.5], buttons: [button] };
        Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => [pad] });
        const snapshot = window.deviceInputFixture.gamepad();
        pad.axes[0] = 1;
        button.value = 0;
        pad.connected = false;
        return { snapshot, disconnected: window.deviceInputFixture.gamepad() };
    });
    expect(result.snapshot?.axes).toEqual([0.5, -0.5]);
    expect(result.snapshot?.buttons[0]?.value).toBe(1);
    expect(result.disconnected).toBeNull();
});

test("clears keyboard state when a focused descendant leaves the input surface", async ({ page }) => {
    await page.locator("#nested-editor").focus();
    await page.keyboard.down("w");
    expect(await page.evaluate(() => window.deviceInputFixture.containerKeys())).toContain("KeyW");
    await page.locator("#editor").focus();
    expect(await page.evaluate(() => window.deviceInputFixture.containerKeys())).toEqual([]);
    await page.keyboard.up("w");
});

test("releases a drag that began outside and moved through the surface", async ({ page }) => {
    const box = (await page.locator("#renderCanvas").boundingBox())!;
    await page.mouse.move(box.x + box.width + 30, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 50, box.y + 40);
    expect(await page.evaluate(() => window.deviceInputFixture.state().buttons)).toBe(1);
    await page.mouse.move(box.x + box.width + 40, box.y + 40);
    await page.mouse.up();
    expect(await page.evaluate(() => window.deviceInputFixture.state().buttons)).toBe(0);
});
