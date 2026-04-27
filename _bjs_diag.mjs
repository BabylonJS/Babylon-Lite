import { chromium } from "@playwright/test";
import * as fs from "fs";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto("http://localhost:5174/babylon-ref-scene72.html", { timeout: 60000 });
await page.waitForTimeout(15000);
const data = await page.evaluate(() => {
    const nm = window.__nm;
    return { fs: nm._fragmentCompilationState?._builtCompilationString || "", defs: nm.getEffect()?.defines || "" };
});
fs.writeFileSync("_bjs72_frag.fx", data.fs);
fs.writeFileSync("_bjs72_defines.txt", data.defs);
console.log("frag:", data.fs.length, "defs:", data.defs.length);
await browser.close();
