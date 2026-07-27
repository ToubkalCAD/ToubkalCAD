# Contributor Guide

ToubkalCAD welcomes focused improvements to code, tests, documentation, and bug
reports. The source repository is
[ToubkalCAD/ToubkalCAD](https://github.com/ToubkalCAD/ToubkalCAD).

## Set up the project

Requirements:

- Node.js 20 or newer for the application
- npm
- Git

```bash
git clone https://github.com/ToubkalCAD/ToubkalCAD.git
cd ToubkalCAD
npm install
npm run dev
```

Open the local URL printed by Vite. Use the repository's normal development
server because ToubkalCAD requires cross-origin isolation headers.

## Before opening a pull request

```bash
npm run lint
npm run build
npm run selftest:run
```

Keep changes focused, explain user-visible behavior, add or update tests when
appropriate, and update documentation when a workflow changes.

## Work on the documentation

```bash
cd docs
npm install
npm run dev
```

Documentation pages are Markdown files. Navigation and site settings live in
`docs/.vitepress/config.ts`.

## Project standards

Read the repository [contribution guidelines](https://github.com/ToubkalCAD/ToubkalCAD/blob/main/CONTRIBUTING.md)
and [security policy](https://github.com/ToubkalCAD/ToubkalCAD/blob/main/SECURITY.md)
before submitting work. Report vulnerabilities privately as directed by the
security policy.
