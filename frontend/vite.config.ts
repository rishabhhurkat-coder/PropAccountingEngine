import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/prop-trading-engine/',
  server: {
    host: '127.0.0.1',
    port: 3489,
    proxy: {
      '/prop-trading-engine/api': {
        target: 'http://127.0.0.1:8002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/prop-trading-engine/, ''),
      },
    },
  },
});
