/**
 * Build Bundle Demo (singular) — build ONE demo by slug for fast iteration,
 * instead of rebuilding every demo via `build-bundle-demos.ts`.
 *
 * Usage:
 *   npx tsx scripts/build-bundle-demo.ts <slug> [--measure]
 *   pnpm build:bundle-demo <slug> [--measure]
 *
 * Examples:
 *   pnpm build:bundle-demo platformer            # build just the platformer bundle
 *   pnpm build:bundle-demo platformer --measure  # also refresh its manifest size
 *
 * The `--measure` flag runs the headless size measurement (slow; needs a
 * browser) and updates this demo's entry in demos-manifest.json. Omit it for
 * the fastest edit → rebuild → refresh loop in the dev server.
 */
import { buildSingleDemo } from "./bundle-demos-core";

const args = process.argv.slice(2);
const measure = args.includes("--measure");
const slug = args.find((a) => !a.startsWith("--"));

if (!slug) {
    console.error("Usage: tsx scripts/build-bundle-demo.ts <slug> [--measure]");
    process.exit(1);
}

buildSingleDemo(slug, { measure }).catch((err) => {
    console.error(err);
    process.exit(1);
});
