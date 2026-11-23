import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'musicword-preview',
    transformIndexHtml: {
      order: 'post',
      handler: () => [{ tag: 'script', attrs: { src: './music-preview/preview.js', defer: true }, injectTo: 'head-prepend' }],
    },
  }],
  server: {
    port: 5176, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4174', '/music-preview': 'http://127.0.0.1:4174' },
  },
});
