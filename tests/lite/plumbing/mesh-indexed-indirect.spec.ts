import { PNG } from "pngjs";
import { expect, test } from "../parity/parity-fixtures";

test("compute-produced indexed arguments change ordinary ShaderMaterial pixels without count readback", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/lite/indexed-indirect-test.html");
    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true");
    const frame = async () => {
        await page.evaluate(async () => {
            for (let frame = 0; frame < 3; frame++) {
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            }
        });
        const image = PNG.sync.read(await canvas.screenshot());
        let left = 0;
        let right = 0;
        for (let y = 0; y < image.height; y++) {
            for (let x = 0; x < image.width; x++) {
                const offset = (y * image.width + x) * 4;
                if (image.data[offset]! > 200 && image.data[offset + 1]! < 10 && image.data[offset + 2]! < 10) {
                    if (x < image.width / 2) {
                        left++;
                    } else {
                        right++;
                    }
                }
            }
        }
        return { left, right };
    };
    const one = await frame();
    expect(one.left).toBe(0);
    expect(one.right).toBeGreaterThan(1000);
    const initialBundles = Number(await canvas.getAttribute("data-bundle-builds"));
    await page.locator("#two").click();
    const two = await frame();
    expect(two.left).toBe(one.right);
    expect(two.right).toBe(one.right);
    expect(Number(await canvas.getAttribute("data-bundle-builds"))).toBe(initialBundles);
    await page.locator("#none").click();
    expect(await frame()).toEqual({ left: 0, right: 0 });
    expect(Number(await canvas.getAttribute("data-bundle-builds"))).toBe(initialBundles);
    await page.locator("#replace").click();
    expect(await frame()).toEqual({ left: one.right, right: 0 });
    expect(Number(await canvas.getAttribute("data-bundle-builds"))).toBeGreaterThan(initialBundles);
    await expect(canvas).toHaveAttribute("data-cpu-index-count", "6");
    await expect(canvas).toHaveAttribute("data-argument-uploads", "0");
    await expect(canvas).toHaveAttribute("data-draw-info", JSON.stringify({ mode: "indirect", indexCapacity: 6, indexCount: null, instanceCount: null }));
    await page.locator("#unbind").click();
    await frame();
    await expect(canvas).toHaveAttribute("data-draw-info", JSON.stringify({ mode: "direct", indexCapacity: 6, indexCount: 6, instanceCount: 1 }));
    await expect(canvas).toHaveAttribute("data-gpu-errors", "[]");
    expect(errors).toEqual([]);
    test.info().annotations.push({ type: "native-pixels", description: JSON.stringify({ one, two, zero: 0, cpuIndexCount: 6, argumentUploads: 0 }) });
});
