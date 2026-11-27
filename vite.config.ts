import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist/web' },
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    hmr: process.env.DISABLE_HMR !== 'true',
  },
});
