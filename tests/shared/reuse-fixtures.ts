/**
 * Shared browser-reuse fixtures and helpers.
 *
 * By default this re-exports Playwright's `test`/`expect`, so behaviour is
 * identical to importing straight from `@playwright/test`.
 *
 * When `REUSE_BROWSER` is set (`REUSE_BROWSER=true` / `1`), EVERY browser-based
 * test (parity, bundle-size, plumbing, perf, GL) shares a single browser window
 * per Playwright worker instead of opening a fresh window per test. In headed
 * local runs this keeps one window in the background rather than popping hundreds
 * of windows to the foreground (and stealing focus) while you work elsewhere.
 *
 * There are three window sources in the suite; all three now funnel through here
 * so REUSE_BROWSER coalesces them into that one window:
 *   1. The per-test `page` fixture — overridden below to a worker-scoped page.
 *   2. Reference/oracle captures that open their own `browser.newContext()` — use
 *      {@link acquireReferencePage}.
 *   3. Perf harnesses that drive a raw `browser.newContext()` — use
 *      {@link acquireContext}.
 *
 * The single window is created once and reused until the Playwright run (CLI
 * invocation) finishes. A new CLI invocation naturally starts its own window.
 */
import { test as base, expect } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";

export const REUSE_BROWSER = process.env.REUSE_BROWSER === "true" || process.env.REUSE_BROWSER === "1";

const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

type Viewport = { width: number; height: number };

/**
 * The single worker-shared context (one OS window) in REUSE_BROWSER mode, or
 * `undefined` when reuse is off. Because Playwright's `browser` fixture is
 * worker-scoped, the first context on the browser is always THE shared window
 * for that worker.
 */
export function reusedContext(browser: Browser): BrowserContext | undefined {
    return REUSE_BROWSER ? browser.contexts()[0] : undefined;
}

/**
 * Acquire a browser context for reference/perf work.
 *
 * In reuse mode this returns the worker's single shared context (creating it if
 * this is the first caller in a worker that hasn't used the `page` fixture yet)
 * and a no-op `release()` so the window stays open for the rest of the run.
 * Otherwise it opens a fresh isolated context and `release()` tears it down, so
 * non-reuse behaviour is byte-for-byte what the callers did before.
 */
export async function acquireContext(browser: Browser, viewport: Viewport = DEFAULT_VIEWPORT): Promise<{ context: BrowserContext; release: () => Promise<void> }> {
    if (REUSE_BROWSER) {
        const context = browser.contexts()[0] ?? (await browser.newContext({ viewport }));
        return { context, release: async () => {} };
    }
    const context = await browser.newContext({ viewport });
    return { context, release: async () => void (await context.close()) };
}

/**
 * Acquire a page for reference/oracle captures.
 *
 * In reuse mode this opens a DEDICATED tab inside the worker's single shared
 * window (never a new window) and applies the requested viewport to it, so the
 * caller gets the viewport it asked for and never has to share the test's own
 * `page`. `release()` closes just that tab — but only while another page keeps
 * the window alive, so the single shared window is never torn down. Otherwise it
 * opens a fresh isolated context+page and `release()` closes them, matching the
 * previous per-spec `browser.newContext()` + `context.close()` behaviour.
 */
export async function acquireReferencePage(browser: Browser, viewport: Viewport = DEFAULT_VIEWPORT): Promise<{ page: Page; release: () => Promise<void> }> {
    if (REUSE_BROWSER) {
        const context = browser.contexts()[0] ?? (await browser.newContext({ viewport }));
        const page = await context.newPage();
        await page.setViewportSize(viewport);
        return {
            page,
            release: async () => {
                // Close our dedicated tab, but keep the window alive: never close
                // the last remaining page, or the single shared window would go away
                // and the next test would have to open a new one.
                if (!page.isClosed() && context.pages().length > 1) {
                    await page.close();
                }
            },
        };
    }
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    return { page, release: async () => void (await context.close()) };
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
const reuseTest = base.extend<{}, { reuseContext: BrowserContext }>({
    // One context (one OS window) per worker, reused across every test the worker runs.
    reuseContext: [
        async ({ browser }, use) => {
            const context = browser.contexts()[0] ?? (await browser.newContext({ viewport: { width: 1280, height: 720 } }));
            await use(context);
            await context.close();
        },
        { scope: "worker" },
    ],
    // Override the built-in test-scoped `page` with a page that lives in the shared
    // worker window. It is reused across tests (each test re-navigates it via
    // page.goto, which resets the document). If a test closes its page (e.g.
    // bundle-size), the next test transparently opens a fresh tab in the SAME
    // window rather than a new window.
    page: async ({ reuseContext }, use) => {
        const live = reuseContext.pages().find((p) => !p.isClosed());
        const page = live ?? (await reuseContext.newPage());
        await use(page);
        // Intentionally left open — the next test in this worker reuses it.
    },
});

export const test = REUSE_BROWSER ? reuseTest : base;
export { expect };
