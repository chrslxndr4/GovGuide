import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';

export default defineConfig({
  integrations: [react(), tailwind()],
  adapter: node({ mode: 'standalone' }),
  output: 'static',
});
