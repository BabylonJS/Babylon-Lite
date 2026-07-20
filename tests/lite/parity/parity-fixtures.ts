/**
 * Parity test fixtures.
 *
 * Thin re-export of the shared browser-reuse fixtures so the ~200 parity specs
 * that import from here keep working unchanged. See
 * `tests/shared/reuse-fixtures.ts` for the actual `REUSE_BROWSER` behaviour and
 * the `acquireReferencePage` / `acquireContext` helpers used by specs that open
 * their own reference/oracle windows.
 */
export { test, expect, REUSE_BROWSER, acquireReferencePage, acquireContext, reusedContext } from "../../shared/reuse-fixtures";
