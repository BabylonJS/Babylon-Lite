// Deploy coordinator / bootstrap — the stable entry every playground deploy ships.
//
// The playground is served in three shapes, all from the same origin:
//   • the canonical nightly build at the root ("/"),
//   • an immutable per-PR snapshot under "/pr/<N>/",
//   • an immutable per-version snapshot under "/v/<ver>/".
// Each is built once with its own PLAYGROUND_BASE baked into `BASE_URL`, and each
// ships THIS module as a stable, unhashed `assets/boot.js`.
//
// Why a coordinator is needed: a deep link like `/pr/387/snippet/XKIIYQ/v/3` has
// no matching file at the origin, so the CDN/Front Door SPA fallback rewrites it
// to the root `/index.html`. Front Door can only rewrite to a single static path
// (it can't reconstruct a per-base one), so that fallback serves the ROOT build's
// `boot.js` for a URL that actually belongs to a snapshot. This guard notices the
// mismatch between the URL's base and the build's baked base and hands off to the
// snapshot's own `boot.js`, which then matches and boots its app. When the base
// already matches — the root, or a snapshot served directly at `/pr/<N>/` — it
// boots straight away.
//
// Deployment stays a single per-target build + upload: the coordinator derives the
// hand-off target from the URL at runtime, so a build made today can bootstrap a
// snapshot published later without being rebuilt.

/** The deploy base implied by the current URL, always trailing-slashed (e.g. `/`, `/pr/387/`). */
function urlBase(): string {
    // `[^/]+` captures the snapshot id (PR number or version) without the trailing
    // slash, so this matches `/pr/387`, `/pr/387/`, and `/pr/387/snippet/...` alike.
    const match = location.pathname.match(/^\/(?:pr|v)\/[^/]+/);
    return match ? `${match[0]}/` : "/";
}

if (urlBase() === import.meta.env.BASE_URL) {
    // This build is the right one for the URL — boot the app.
    void import("./main");
} else {
    // A build reached via SPA fallback for a snapshot deep link. Hand off to the
    // snapshot's own stable coordinator, which will match its base and boot.
    void import(/* @vite-ignore */ `${urlBase()}assets/boot.js`);
}
