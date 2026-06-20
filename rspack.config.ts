// ============================================================
// AtlasCAD – rspack.config.ts  (v3 – Rspack 2.x + OCC beta)
//
// CHANGEMENTS CLÉS vs v1 :
//   • @rspack/core 2.0  : defineConfig vient de @rspack/core
//   • opencascade.js@beta : les .wasm doivent être servis comme
//     URLs (file-loader, type: "javascript/auto") — PAS le
//     asyncWebAssembly experiment natif de Rspack
//   • fallback étendu : fs, perf_hooks, os, worker_threads,
//     crypto, stream (requis par Emscripten/OCC)
//   • output.publicPath: "auto" pour que les URLs WASM soient
//     correctement résolues quel que soit le chemin de déploiement
//   • Cross-Origin headers activés (COOP + COEP) obligatoires
//     pour SharedArrayBuffer et les Web Workers WASM
// ============================================================

import { HtmlRspackPlugin, CopyRspackPlugin } from '@rspack/core';
import type { Configuration } from '@rspack/core';
// defineConfig is a no-op type helper — inline the type instead
const defineConfig = (c: Configuration): Configuration => c;
import path from 'path';

export default defineConfig({
  entry: {
    main: './src/index.tsx',
  },

  output: {
    path:       path.resolve(__dirname, 'dist'),
    filename:   '[name].[contenthash:8].js',
    publicPath: 'auto',  // ← critique pour les URLs WASM dynamiques
    clean:      true,
  },

  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    fallback: {
      // Modules Node.js non disponibles dans le navigateur
      // requis par Emscripten (OpenCascade.js)
      fs:             false,
      path:           false,
      crypto:         false,
      os:             false,
      stream:         false,
      perf_hooks:     false,
      worker_threads: false,
    },
  },

  module: {
    rules: [
      // ── TypeScript / TSX via builtin SWC loader ─────────────────
      {
        test: /\.(ts|tsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              parser: {
                syntax:     'typescript',
                tsx:        true,
                decorators: false,
              },
              transform: {
                react: {
                  runtime: 'automatic',
                },
              },
              target: 'es2020',
            },
          },
        },
        type: 'javascript/auto',
      },

      // ── CSS ──────────────────────────────────────────────────────
      {
        test: /\.css$/,
        type: 'css',
      },

      // ── WASM — opencascade.js@beta ───────────────────────────────
      // IMPORTANT : il NE faut PAS utiliser experiments.asyncWebAssembly
      // avec opencascade.js@beta. OCC gère lui-même le chargement du
      // .wasm via fetch(). Le bundler doit simplement copier les fichiers
      // .wasm dans le dossier de sortie et exposer leur URL finale.
      // file-loader fait exactement cela : il copie le fichier et retourne
      // son URL publique (avec content-hash pour le cache HTTP).
      {
        test:   /\.wasm$/,
        type:   'javascript/auto',   // désactive le traitement natif Rspack
        loader: 'file-loader',
        options: {
          name: 'wasm/[name].[contenthash:8].[ext]',  // → dist/wasm/*.wasm
        },
      },

      // ── Images & icônes ─────────────────────────────────────────
      {
        test:  /\.(png|svg|jpg|jpeg|gif|ico)$/i,
        type: 'asset/resource',
        generator: {
          filename: 'assets/[name].[contenthash:8][ext]',
        },
      },

      // ── Polices ─────────────────────────────────────────────────
      {
        test: /\.(woff|woff2|eot|ttf|otf)$/i,
        type: 'asset/resource',
        generator: {
          filename: 'fonts/[name].[contenthash:8][ext]',
        },
      },
    ],
  },

  plugins: [
    new HtmlRspackPlugin({
      template: './public/index.html',
    }),
    // SolveSpace solver glue (native/slvs/build.sh output). Emitted to the dist
    // root so loadSlvs()'s `webpackIgnore` runtime import (./libslvs.mjs)
    // resolves next to the bundle. noErrorOnMissing → the build still succeeds
    // when the WASM hasn't been built (legacy solver stays active).
    new CopyRspackPlugin({
      patterns: [
        { from: 'src/services/solver/wasm/libslvs.mjs', to: 'libslvs.mjs', noErrorOnMissing: true },
      ],
    }),
  ],

  // OCC manages its own WASM loading — do NOT use asyncWebAssembly here
  experiments: {},

  optimization: {
    // Séparer les vendors pour améliorer le cache
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        three: {
          test:     /[\\/]node_modules[\\/]three[\\/]/,
          name:     'vendor-three',
          priority: 20,
        },
        vendor: {
          test:     /[\\/]node_modules[\\/]/,
          name:     'vendor',
          priority: 10,
        },
      },
    },
  },

  devServer: {
    port:               8080,
    historyApiFallback: true,
    hot:                true,
    // ── Headers OBLIGATOIRES pour SharedArrayBuffer (WASM threads) ─
    // Sans COOP + COEP, le navigateur bloque SharedArrayBuffer et
    // les Web Workers multi-thread d'Emscripten ne peuvent pas s'initialiser.
    headers: {
      'Cross-Origin-Opener-Policy':   'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    static: true,

    // ── Cache the 48 MB content-hashed WASM kernel "forever" ──────────────
    // The filename carries a content hash, so the URL only changes when the
    // wasm itself changes — making it safe to cache immutably. After the FIRST
    // load the browser serves it from disk cache (and V8 reuses its compiled
    // code cache), so normal reloads (F5) become near-instant instead of
    // re-downloading + re-compiling 48 MB. NB: a hard reload (Ctrl+Shift+R)
    // intentionally bypasses the cache, so use a normal reload to benefit.
    // Only *.wasm gets this header — index.html / JS bundles are untouched,
    // and the critical COOP/COEP headers above are left exactly as they were.
    setupMiddlewares: (middlewares) => {
      middlewares.unshift({
        name: 'wasm-immutable-cache',
        middleware: (
          req:  import('http').IncomingMessage,
          res:  import('http').ServerResponse,
          next: (err?: unknown) => void,
        ) => {
          if (req.url && req.url.includes('.wasm')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
          next();
        },
      });
      return middlewares;
    },
  },
});
