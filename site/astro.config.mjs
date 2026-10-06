import { defineConfig } from 'astro/config';
import tailwind from '@tailwindcss/vite';

// Deployed to Cloudflare from this directory: root `site`, build `pnpm build`,
// output `site/dist`. A static build needs no Cloudflare adapter.
//
// Every page is a real Astro route in the one field-guide design world. The Pi
// walkthrough's contract pages are static endpoints rendered by the plugin itself.
export default defineConfig({
  site: 'https://ideation.engineering',
  build: {
    // The site's standing rule: no external requests, everything inline.
    inlineStylesheets: 'always',
    assets: '_assets',
  },
  vite: { plugins: [tailwind()] },
});
