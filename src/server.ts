import express from 'express';
import { join, resolve } from 'node:path';
import { agentVersion, loadEnvironment } from './config.js';
import { createReviewModel } from './model/provider.js';
import { createApp } from './server/app.js';

loadEnvironment();
const development = process.argv.includes('--dev');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST?.trim() || (process.env.PORT || development ? '0.0.0.0' : '127.0.0.1');
const app = createApp({
  version: agentVersion(),
  getModel: createReviewModel,
  accessCode: process.env.REVIEW_ACCESS_CODE?.trim(),
});

if (development) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const assets = resolve('dist/web');
  app.use(express.static(assets, { index: false }));
  app.get('/', (_request, response) => response.sendFile(join(assets, 'index.html')));
}
app.listen(port, host, () => console.log(`Requirements Validator is listening on http://${host}:${port}`));
