// Asset module declarations. `.wasm` files are handled by rspack's file-loader
// rule (rspack.config.ts) as `type: 'javascript/auto'`, which exports the
// emitted hashed URL as the default. PlaneGCS's .wasm is imported this way in
// src/index.tsx and routed through init_planegcs_module's `locateFile`.
declare module '*.wasm' {
  const url: string;
  export default url;
}
