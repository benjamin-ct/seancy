// Déclaration de module pour les imports `.wasm` (voir posterThumbhash.ts) :
// Wrangler les résout en `WebAssembly.Module` au bundling, TypeScript n'a
// sinon aucune idée de ce qu'est un import `.wasm`.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
