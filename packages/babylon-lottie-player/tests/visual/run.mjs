import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceDir = resolve(packageDir, "../..");

const cleanEnv = { ...process.env };
delete cleanEnv.LOTTIE_VISUAL_MODE;
delete cleanEnv.LOTTIE_VISUAL_PLAYER;
delete cleanEnv.UPDATE_GOLDENS;

execFileSync(process.execPath, [resolve(workspaceDir, "node_modules/playwright/cli.js"), "test", "--config", resolve(packageDir, "playwright.visual.config.ts")], {
    cwd: packageDir,
    stdio: "inherit",
    env: { ...cleanEnv, LOTTIE_VISUAL_MODE: "candidate" },
});
