// Live viewer dev server: stages assets, then esbuild watches demo/main.ts (+ the package and
// babylon-lite-gl source it pulls in) and serves demo/dist. Open the printed URL and pick an
// animation from the dropdown — edits rebuild automatically on the next refresh.
//
//   node packages/babylon-lottie-player/demo/serve.mjs
import { context } from "esbuild";
import { mainBuildOptions, workerBuildOptions, stageAssets, DIST } from "./_shared.mjs";

const manifest = stageAssets();
const mainCtx = await context(mainBuildOptions);
const workerCtx = await context(workerBuildOptions);
await Promise.all([mainCtx.watch(), workerCtx.watch()]);

let served;
try {
    served = await mainCtx.serve({ servedir: DIST, port: 5180, host: "127.0.0.1" });
} catch {
    // Port busy — let esbuild pick an open one.
    served = await mainCtx.serve({ servedir: DIST, host: "127.0.0.1" });
}

console.log(`
  Babylon Lottie Player viewer:  http://localhost:${served.port}/

  Animations in the dropdown: ${manifest.join(", ")}
  Controls: dropdown to switch · Play/Pause · drag the slider to scrub frames.
  Edits to the player source or demo rebuild automatically (just refresh).
  Ctrl+C to stop.
`);
