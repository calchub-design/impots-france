import { defineConfig } from 'vite';

const serverPort = Number(process.env.PORT ?? 8080);

export default defineConfig({
  root: 'client',
  server: {
    host: true,
    port: Number(process.env.CLIENT_PORT ?? 5173),
    proxy: {
      '/api': `http://localhost:${serverPort}`,
      '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
});
