import { SalesError } from '../lib/sales.js';
import { assertSameOrigin, createSessionManager } from '../lib/session.js';
import { readJson, sendJson } from './sales.js';

export const config = { api: { bodyParser: false } };

// v2 T1 (S4/S6): same-origin /api/session login/status/logout for the
// Supabase-only v2 runtime. It exists whenever the app runs (there is no
// other mode) and reuses the shared JSON/body-limit contract from the sales
// endpoint; an unconfigured app fails closed through the session manager.
export function createSessionHandler({ env = process.env, supabaseFetch = globalThis.fetch } = {}) {
  const manager = createSessionManager({ env, supabaseFetch });
  return async (req, res) => {
    const path = req.url.split('?')[0];
    if (path !== '/api/session') return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'No encontrado.' } });
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, await manager.status(req, res));
      } else if (req.method === 'POST') {
        assertSameOrigin(req, env); // before reading any body
        const body = await readJson(req);
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!email || !email.includes('@') || !password) {
          throw new SalesError(400, 'INVALID_LOGIN', 'Ingresá un correo y una contraseña.');
        }
        // The password is handed straight to Supabase Auth and never stored,
        // logged or echoed back. Any cookie is an encrypted token container.
        sendJson(res, 200, await manager.login(email, password, res));
      } else if (req.method === 'DELETE') {
        assertSameOrigin(req, env);
        sendJson(res, 200, await manager.logout(req, res));
      } else {
        res.setHeader('Allow', 'GET, POST, DELETE');
        throw new SalesError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
      }
    } catch (error) {
      if (error instanceof SalesError) sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      else sendJson(res, 503, { error: { code: 'SESSION_UNAVAILABLE', message: 'No se pudo procesar la sesión. Reintentá en unos momentos.' } });
    }
  };
}

export default createSessionHandler();
