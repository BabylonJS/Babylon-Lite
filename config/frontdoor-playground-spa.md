# Front Door rules for the Lite Playground snapshots

The playground is served as a single origin with three shapes:

| Shape            | URL                                             | Built by                        |
| ---------------- | ----------------------------------------------- | ------------------------------- |
| Nightly (master) | `https://liteplayground.babylonjs.com/`         | `azure-pipelines-playground.yml`|
| Per-PR snapshot  | `https://liteplayground.babylonjs.com/pr/<N>/`  | `azure-pipelines.yml`           |
| Per-version      | `https://liteplayground.babylonjs.com/v/<ver>/` | `azure-pipelines-npm-publish.yml`|

Each is an immutable, independently built static site. The app is a History-API
SPA, so a deep link or hard refresh (e.g. `/pr/387/snippet/XKIIYQ/v/3`) requests a
path that has **no file** at the origin. Front Door must serve the app shell for
those paths instead of a 404.

## Why one static rewrite is enough

Azure Front Door Standard/Premium **URL Rewrite** only rewrites a prefix to a
single **static** destination — it has no regex capture groups or server
variables ([docs](https://learn.microsoft.com/azure/frontdoor/front-door-url-rewrite)).
So it cannot compute a *per-base* fallback like `/pr/387/index.html`. It can only
ever fall back to one path: the root `/index.html`.

That is exactly enough, because every deploy ships the same stable coordinator at
`assets/boot.js` (loaded by every `index.html`). When the root `index.html` is
served for a snapshot deep link, its coordinator reads `location.pathname`,
derives the base (`/pr/387/`), and hands off to `/pr/387/assets/boot.js`, which
boots the PR build. See `playground/src/entry.ts`.

## The rule set (one rule)

Attach a rule set to the playground route with a single rule.

**Conditions (AND):**

1. **Request file extension** — `Operator: Equal`, `Negate: true`, values = the
   asset allow-list below. (Requests that already point at a real file — with an
   extension — pass through to blob storage untouched.)
2. **URL path** — `Operator: EndsWith`, `Negate: true`, value = `/`. (Directory
   roots like `/`, `/pr/387/`, `/v/1.4.0/` are served natively by blob static
   website's index document, so they skip the rewrite.)

**Action:** **URL rewrite** — Source pattern `/`, Destination `/index.html`,
Preserve unmatched path `No`.

### ARM / Bicep shape

```json
{
  "name": "SpaFallback",
  "order": 1,
  "conditions": [
    {
      "name": "RequestFileExtension",
      "parameters": {
        "typeName": "DeliveryRuleRequestFileExtensionConditionParameters",
        "operator": "Equal",
        "negateCondition": true,
        "matchValues": [
          "js", "mjs", "css", "map", "json", "html", "wasm", "ts", "wgsl",
          "txt", "xml", "csv", "ico", "svg", "png", "jpg", "jpeg", "gif",
          "webp", "avif", "bmp", "woff", "woff2", "ttf", "otf", "eot",
          "env", "dds", "ktx", "ktx2", "basis", "hdr", "exr",
          "glb", "gltf", "obj", "stl", "bin", "mp3", "wav", "ogg", "m4a",
          "mp4", "webm"
        ],
        "transforms": ["Lowercase"]
      }
    },
    {
      "name": "UrlPath",
      "parameters": {
        "typeName": "DeliveryRuleUrlPathMatchConditionParameters",
        "operator": "EndsWith",
        "negateCondition": true,
        "matchValues": ["/"],
        "transforms": []
      }
    }
  ],
  "actions": [
    {
      "name": "UrlRewrite",
      "parameters": {
        "typeName": "DeliveryRuleUrlRewriteActionParameters",
        "sourcePattern": "/",
        "destination": "/index.html",
        "preserveUnmatchedPath": false
      }
    }
  ]
}
```

## Caching

- `index.html` and `assets/boot.js` — **no-cache / must-revalidate**. They are the
  stable coordinator surface; they must always reflect the latest deploy. The
  nightly pipeline purges the CDN endpoint on every master deploy, which flushes
  the root copies.
- Everything under `assets/*-[hash].*`, `/v/<ver>/**`, and `/pr/<N>/**` other than
  `boot.js`/`index.html` — content-hashed or immutable, safe to cache long-term.

## Edge cases

- **Bare snapshot root without a trailing slash** (`/pr/387`): condition 2 is not
  met (doesn't end with `/`) and it has no extension, so it is rewritten to
  `/index.html`; the coordinator still derives `/pr/387/` and hands off correctly.
- **The `runner.html` iframe and engine files** (`/pr/387/runner.html`,
  `/pr/387/engine/dev/index.js`, `index.d.ts`) all carry extensions in the
  allow-list, so they pass through to blob storage and are never rewritten.
- **Legacy hash links** (`/#XKIIYQ`) never reach the server and keep working; the
  app also still parses the path form for backward compatibility.
