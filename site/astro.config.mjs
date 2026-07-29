import { defineConfig } from 'astro/config';
import tailwind from '@tailwindcss/vite';

// Deployed to Cloudflare from this directory: root `site`, build `pnpm build`,
// output `site/dist`. A static build needs no Cloudflare adapter.
//
// Every page is a real Astro route: / and /walkthrough in the Industry design
// system, /guide in the older field-guide one. All three ship from one deploy.
export default defineConfig({
  site: 'https://ideation.engineering',
  build: {
    // The site's standing rule: no external requests, everything inline.
    inlineStylesheets: 'always',
    assets: '_assets',
  },
  vite: { plugins: [tailwind()] },
});
