import { defineConfig } from "vitepress";
import { configureDiagramsPlugin } from "vitepress-plugin-diagrams";

export default defineConfig({
  title: "iPodRocks",
  description:
    "Sync manager for Rockbox and mountable devices — documentation",
  base: "/",
  lastUpdated: true,
  ignoreDeadLinks: [/\.excalidraw$/],

  vite: {
    build: {
      target: "esnext",
    },
  },

  markdown: {
    config: (md) => {
      configureDiagramsPlugin(md, {
        diagramsDir: "docs/public/diagrams",
        publicPath: "/diagrams",
      });
    },
  },

  themeConfig: {
    nav: [
      { text: "Overview", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Architecture", link: "/guide/architecture" },
      { text: "App Reference", link: "/app-reference/welcome" },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Architecture", link: "/guide/architecture" },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
          ],
        },
      ],
      "/app-reference/": [
        {
          text: "App Reference",
          items: [
            { text: "Welcome", link: "/app-reference/welcome" },
            { text: "Dashboard", link: "/app-reference/dashboard" },
            { text: "Library", link: "/app-reference/library" },
            { text: "Devices", link: "/app-reference/devices" },
            {
              text: "Playlists",
              items: [
                { text: "Overview", link: "/app-reference/playlists" },
                { text: "All Playlists", link: "/app-reference/playlists-all" },
                {
                  text: "Smart Playlists",
                  link: "/app-reference/playlists-smart",
                },
                {
                  text: "Genius Playlists",
                  link: "/app-reference/playlists-genius",
                },
                {
                  text: "Savant Playlists (AI)",
                  link: "/app-reference/playlists-savant",
                },
              ],
            },
            { text: "Auto Podcasts", link: "/app-reference/autopodcasts" },
            { text: "Sync", link: "/app-reference/sync" },
            {
              text: "Settings",
              items: [
                { text: "Overview", link: "/app-reference/settings" },
                {
                  text: "OpenRouter API",
                  link: "/app-reference/settings-openrouter",
                },
                {
                  text: "Harmonic Analysis",
                  link: "/app-reference/settings-harmonic",
                },
              ],
            },
            { text: "Ratings", link: "/app-reference/ratings" },
            { text: "Music Assistant", link: "/app-reference/assistant" },
          ],
        },
      ],
    },

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/JoaoSobral/ipodrocks-js",
      },
    ],

    search: {
      provider: "local",
    },
  },
});
