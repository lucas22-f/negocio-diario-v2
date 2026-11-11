import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createSessionHandler } from './api/session.js';
import { createSalesHandler, sendJson } from './api/sales.js';
import { createProductsHandler } from './api/products.js';
import { createStockDaysHandler } from './api/stock-days.js';

const publicRoot = new URL('./public/', import.meta.url);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

export function createApp(options = {}) {
  const sales = createSalesHandler(options);
  const products = createProductsHandler(options);
  const session = createSessionHandler(options);
  const stockDays = createStockDaysHandler(options);
  return createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/api/sales') return sales(req, res);
    if (path === '/api/products') return products(req, res);
    if (path === '/api/session') return session(req, res);
    if (path === '/api/stock-days') return stockDays(req, res);
    const file = files.get(path);
    if (!file || !['GET', 'HEAD'].includes(req.method)) {
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'No encontrado.' } });
    }
    try {
      const content = await readFile(new URL(file[0], publicRoot));
      res.writeHead(200, {
        'Content-Type': file[1], 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
      sendJson(res, 500, { error: { code: 'SERVER_ERROR', message: 'No se pudo abrir la página.' } });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Supabase-only v2: no local storage flag exists; without configuration the
  // API fails closed (503) on every endpoint.
  const env = { ...process.env };
  const server = createApp({ env });
  const port = Number(env.PORT || 3000);
  server.listen(port, env.HOST || '127.0.0.1', () => {
    console.log(`Negocio Diario v2 (pochoclos-1): http://${env.HOST || '127.0.0.1'}:${server.address().port}`);
    console.log('Supabase requerido: sin configuración la API falla cerrada (503).');
  });
}
