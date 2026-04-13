import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: {
    proxy: {
      // Proxy HubSpot API calls in dev mode — converts x-hubspot-token to Bearer auth
      '/api/hubspot': {
        target: 'https://api.hubapi.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/hubspot/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const token = req.headers['x-hubspot-token'];
            if (token) {
              proxyReq.removeHeader('x-hubspot-token');
              proxyReq.setHeader('Authorization', `Bearer ${token}`);
            }
          });
        },
      },
    },
  },
})
