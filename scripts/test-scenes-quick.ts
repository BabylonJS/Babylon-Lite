import { chromium } from '@playwright/test';
import { createServer, type Server } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(__dirname, '..', 'lab');
const publicDir = join(labDir, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      const url = (req.url ?? '/').split('?')[0]!;
      let filePath = join(labDir, url === '/' ? 'index.html' : url);
      if (!existsSync(filePath)) filePath = join(publicDir, url);
      if (existsSync(filePath)) {
        resp.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
        resp.end(readFileSync(filePath));
      } else {
        resp.writeHead(404);
        resp.end();
      }
    });
    server.listen(0, () => {
      const addr = server.address();
      res({ server, port: typeof addr === 'object' ? addr!.port : 0 });
    });
  });
}

const scenes = ['scene1','scene2','scene3','scene4','scene5','scene6','scene7','scene8','scene9','scene10','scene11','scene12','scene13','scene14'];

async function main() {
  const { server, port } = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  for (const scene of scenes) {
    process.stdout.write(`${scene}: `);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

    try {
      await page.goto(`http://localhost:${port}/lite/bundle-${scene}.html`);
      await page.waitForFunction(
        () => document.querySelector('canvas')?.dataset.ready === 'true',
        { timeout: 10_000 },
      );
      console.log('OK');
    } catch {
      console.log('FAILED');
      for (const e of errors) console.log(`  ERROR: ${e.substring(0, 200)}`);
    }
    await page.close();
  }

  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
