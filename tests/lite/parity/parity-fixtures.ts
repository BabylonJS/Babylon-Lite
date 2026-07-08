/**
 * Parity test fixtures.
 *
 * By default this simply re-exports Playwright's `test`/`expect`, so behaviour is
 * identical to importing straight from `@playwright/test`.
 *
 * When `REUSE_BROWSER` is set (`REUSE_BROWSER=true` / `1`), the built-in
 * per-test `page` fixture is replaced with a single **worker-scoped** page that
 * is created once and reused by every scene spec that worker runs. In headed
 * mode this means one browser window per worker is opened once, sinks to the
 * background, and stays there for the whole run — instead of a fresh window
 * popping to the foreground (and closing) for each of the ~200 scene specs.
 *
 * The reused page is re-navigated by each test's `page.goto(...)`, which resets
 * the document, so per-test isolation of scene state is preserved. Only the
 * OS-level window/context is shared. `captureGolden` (compare-core) honours the
 * same flag and reuses the worker context/page instead of opening its own.
 */
import { test as base, expect, type Page } from "@playwright/test";

export const REUSE_BROWSER = process.env.REUSE_BROWSER === "true" || process.env.REUSE_BROWSER === "1";

type ReuseWorkerFixtures = { reusedPage: Page };

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
const reuseTest = base.extend<{}, ReuseWorkerFixtures>({
    // One page (and therefore one context + one window) per worker, reused across tests.
    reusedPage: [
        async ({ browser }, use) => {
            const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
            const page = await context.newPage();
            await use(page);
            await context.close();
        },
        { scope: "worker" },
    ],
    // Override the built-in test-scoped `page` to hand back the shared worker page.
    page: async ({ reusedPage }, use) => {
        await use(reusedPage);
    },
});

export const test = REUSE_BROWSER ? reuseTest : base;
export { expect };
