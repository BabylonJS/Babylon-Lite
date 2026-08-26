import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { buildVisualApp, visualOutDir } from "./build.mjs";

await buildVisualApp();

const port = Number(process.env.LOTTIE_VISUAL_PORT ?? 5191);
const mime = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".png", "image/png"],
]);

createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
    const path = resolve(visualOutDir, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(`${visualOutDir}${sep}`)) {
        response.statusCode = 403;
        response.end("Forbidden");
        return;
    }
    try {
        response.setHeader("Content-Type", mime.get(extname(path)) ?? "application/octet-stream");
        response.end(await readFile(path));
    } catch {
        response.statusCode = 404;
        response.end("Not found");
    }
}).listen(port, "127.0.0.1", () => console.log(`Lottie player visual server: http://127.0.0.1:${port}`));
