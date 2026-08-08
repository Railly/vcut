import { defineConfig } from 'astro/config'
import { vcutTheme } from './src/shiki-theme.ts'

export default defineConfig({
  site: 'https://vcut.crafter.run',
  markdown: {
    shikiConfig: {
      theme: vcutTheme,
    },
  },
})
