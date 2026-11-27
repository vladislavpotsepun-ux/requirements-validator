import express from 'express';
import { join, resolve } from 'node:path';
import { agentVersion, loadEnvironment } from './config.js';
import { createReviewModel, detectAvailableProviders } from './model/provider.js';
import { createApp } from './server/app.js';
import type { ReviewMode } from './review/types.js';

loadEnvironment();
const development = process.argv.includes('--dev');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST?.trim() || (process.env.PORT || development ? '0.0.0.0' : '127.0.0.1');
const defaultMode: ReviewMode = process.env.REVIEW_MODE?.trim().toLowerCase() === 'fintech' ? 'fintech' : 'standard';
const app = createApp({
  version: agentVersion(),
  getModel: (provider) => createReviewModel(process.env, undefined, provider),
  getAvailableProviders: () => detectAvailableProviders(process.env),
  accessCode: process.env.REVIEW_ACCESS_CODE?.trim(),
  defaultMode,
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
const server = app.listen(port, host, () => console.log(`Requirements Validator is listening on http://${host}:${port}`));
server.requestTimeout = 0;
