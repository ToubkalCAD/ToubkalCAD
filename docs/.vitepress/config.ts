import { defineConfig } from "vitepress";

export default defineConfig({
  title: "ToubkalCAD Documentation",
  description: "Learn, use, and contribute to ToubkalCAD.",
  lang: "en-US",
  srcExclude: ["ROADMAP.md", "PARAMETRIC.md", "REFERENCE-GEOMETRY.md"],
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#071526" }],
  ],
  themeConfig: {
    logo: "/favicon.svg",
    siteTitle: "ToubkalCAD Docs",
    nav: [
      { text: "User Guide", link: "/getting-started/introduction" },
      { text: "Tutorials", link: "/tutorials/" },
      { text: "Reference", link: "/reference/" },
      { text: "Contribute", link: "/contributing/" },
      { text: "Developer", link: "/developer/" },
      {
        text: "Open ToubkalCAD",
        link: "https://toubkal-cad.vercel.app",
      },
    ],
    sidebar: {
      "/getting-started/": [
        {
          text: "Getting Started",
          items: [
            { text: "Introduction", link: "/getting-started/introduction" },
            {
              text: "Browser Requirements",
              link: "/getting-started/browser-requirements",
            },
            {
              text: "Launch ToubkalCAD",
              link: "/getting-started/launch-toubkalcad",
            },
            {
              text: "Interface Overview",
              link: "/getting-started/interface-overview",
            },
            { text: "Create Your First Model", link: "/getting-started/first-model" },
          ],
        },
        {
          text: "Continue Learning",
          items: [
            { text: "Tutorials", link: "/tutorials/" },
            { text: "User Guide", link: "/user-guide/" },
          ],
        },
      ],
      "/tutorials/": [
        {
          text: "Tutorials",
          items: [
            { text: "Overview", link: "/tutorials/" },
            {
              text: "Model a Mounting Bracket",
              link: "/tutorials/mounting-bracket",
            },
          ],
        },
      ],
      "/user-guide/": [
        {
          text: "User Guide",
          items: [
            { text: "Overview", link: "/user-guide/" },
            {
              text: "Projects and Files",
              link: "/user-guide/projects-and-files",
            },
            {
              text: "Viewport Navigation",
              link: "/user-guide/viewport-navigation",
            },
            {
              text: "Selection and Model Tree",
              link: "/user-guide/selection-and-model-tree",
            },
            { text: "Sketching", link: "/user-guide/sketching/" },
            { text: "Part Modeling", link: "/user-guide/part-modeling/" },
            {
              text: "Reference Geometry",
              link: "/user-guide/reference-geometry/",
            },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Overview", link: "/reference/" },
            {
              text: "Keyboard Shortcuts",
              link: "/reference/keyboard-shortcuts",
            },
            {
              text: "Current Limitations",
              link: "/reference/current-limitations",
            },
          ],
        },
      ],
      "/troubleshooting/": [
        {
          text: "Troubleshooting",
          items: [
            { text: "Overview", link: "/troubleshooting/" },
            {
              text: "Startup and WebAssembly",
              link: "/troubleshooting/startup-and-wasm",
            },
          ],
        },
      ],
      "/contributing/": [
        {
          text: "Contributing",
          items: [{ text: "Contributor Guide", link: "/contributing/" }],
        },
      ],
      "/developer/": [
        {
          text: "Developer Documentation",
          items: [
            { text: "Overview", link: "/developer/" },
            {
              text: "Architecture Overview",
              link: "/developer/architecture-overview",
            },
          ],
        },
      ],
      "/project/": [
        {
          text: "Project",
          items: [
            {
              text: "Status and Roadmap",
              link: "/project/status-and-roadmap",
            },
          ],
        },
      ],
    },
    search: {
      provider: "local",
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/ToubkalCAD/ToubkalCAD" },
    ],
    editLink: {
      pattern:
        "https://github.com/ToubkalCAD/ToubkalCAD/edit/main/docs/:path",
      text: "Improve this page on GitHub",
    },
    footer: {
      message: "Open-source browser CAD, built in the Atlas.",
      copyright: "ToubkalCAD documentation",
    },
    outline: [2, 3],
    lastUpdated: {
      text: "Updated",
      formatOptions: {
        dateStyle: "medium",
      },
    },
  },
});
