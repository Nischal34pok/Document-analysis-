import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { attachUserMiddleware } from './server/auth.ts';
import { apiRouter } from './server/routes.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true, limit: '4mb' }));
  app.use(cookieParser());

  // Attach authenticated or isolated guest user session to /api routes
  app.use('/api', attachUserMiddleware);
  app.use('/api', apiRouter);
  app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const e = err as { code?: string; status?: number; statusCode?: number; message?: string; type?: string };
    if (e?.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File exceeds the 25 MB per-file upload limit.', code: 'LIMIT_FILE_SIZE' });
      return;
    }
    if (e?.code === 'LIMIT_FILE_COUNT') {
      res.status(400).json({ error: 'You can upload up to 10 files at once.', code: 'LIMIT_FILE_COUNT' });
      return;
    }
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON request payload.', code: 'INVALID_JSON' });
      return;
    }
    const status = e?.statusCode || e?.status || 500;
    res.status(status).json({ error: e?.message || 'Unexpected server error.', code: e?.code || 'SERVER_ERROR' });
  });

  if (!isProduction) {
    app.get('/@vite/client', (_req, res) => {
      res.type('application/javascript');
      res.send(`
const sheetsMap = new Map();
export class ErrorOverlay {}
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}
export function injectQuery(url) {
  return url;
}
export function createHotContext() {
  const noop = () => {};
  return {
    data: {},
    accept: noop,
    acceptExports: noop,
    dispose: noop,
    prune: noop,
    decline: noop,
    invalidate: noop,
    on: noop,
    off: noop,
    send: noop,
  };
}
`);
    });

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DocuMind AI server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start DocuMind AI server:', err);
  process.exit(1);
});
