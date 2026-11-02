import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateTemporalAo } from "../../../scripts/ao-reference/validate-temporal.js";

const calls = vi.hoisted(() => ({
    server: vi.fn(),
    listen: vi.fn(),
    closeServer: vi.fn(),
    launch: vi.fn(),
    closeBrowser: vi.fn(),
    newPage: vi.fn(),
    goto: vi.fn(),
    evaluate: vi.fn(),
}));
vi.mock("vite", () => ({ createServer: calls.server }));
vi.mock("@playwright/test", () => ({ chromium: { launch: calls.launch } }));

beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "table").mockImplementation(() => {});
    calls.server.mockResolvedValue({
        listen: calls.listen,
        close: calls.closeServer,
        httpServer: { address: () => ({ port: 12345 }) },
    });
    calls.launch.mockResolvedValue({ newPage: calls.newPage, close: calls.closeBrowser });
    calls.newPage.mockResolvedValue({ goto: calls.goto, evaluate: calls.evaluate });
    calls.evaluate.mockResolvedValue([{ case: "numerical GPU result" }]);
});
afterEach(() => vi.restoreAllMocks());

describe("temporal AO validation runner", () => {
    it("runs the production selection by default and closes owned resources", async () => {
        await validateTemporalAo([]);
        expect(calls.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
        expect(calls.goto).toHaveBeenCalledWith("http://127.0.0.1:12345/temporal-check");
        expect(calls.evaluate.mock.calls[0]![1]).toEqual({
            suite: "production",
            profile: "default",
            halfResolution: false,
            software: false,
        });
        expect(calls.closeBrowser).toHaveBeenCalledOnce();
        expect(calls.closeServer).toHaveBeenCalledOnce();
    });
    it("passes the explicit legacy selection without changing the production default", async () => {
        await validateTemporalAo(["--legacy"]);
        expect(calls.evaluate.mock.calls[0]![1].suite).toBe("legacy");
    });
    it("forwards a half-resolution moving profile and explicit software browser mode", async () => {
        await validateTemporalAo(["--moving", "--half", "--close-up-reversal", "--software"]);
        expect(calls.evaluate.mock.calls[0]![1]).toEqual({
            suite: "moving",
            profile: "close-up-reversal",
            halfResolution: true,
            software: true,
        });
        expect(calls.launch).toHaveBeenCalledWith(expect.objectContaining({ channel: "chromium", args: expect.arrayContaining(["--use-webgpu-adapter=swiftshader"]) }));
    });
    it("rejects invalid selectors before allocating a server or browser", async () => {
        await expect(validateTemporalAo(["--legacy", "--half"])).rejects.toThrow("cannot be combined");
        expect(calls.server).not.toHaveBeenCalled();
        expect(calls.launch).not.toHaveBeenCalled();
    });
    it("rejects retired quarter mode before allocating validation resources", async () => {
        await expect(validateTemporalAo(["--quarter", "--software"])).rejects.toThrow("Unknown");
        expect(calls.server).not.toHaveBeenCalled();
        expect(calls.launch).not.toHaveBeenCalled();
    });
    it("closes the server and propagates browser-launch failures", async () => {
        calls.launch.mockRejectedValueOnce(new Error("Browser unavailable"));
        await expect(validateTemporalAo([])).rejects.toThrow("Browser unavailable");
        expect(calls.closeServer).toHaveBeenCalledOnce();
        expect(calls.closeBrowser).not.toHaveBeenCalled();
    });
    it("closes both resources and propagates numerical validation failures", async () => {
        calls.evaluate.mockRejectedValueOnce(new Error("Invalid history"));
        await expect(validateTemporalAo([])).rejects.toThrow("Invalid history");
        expect(calls.closeBrowser).toHaveBeenCalledOnce();
        expect(calls.closeServer).toHaveBeenCalledOnce();
    });
});
