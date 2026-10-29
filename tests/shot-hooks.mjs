const STUB = new URL('./shot-stubs.mjs', import.meta.url).href;
const STUBBED = new Set(['media.js', 'make.js']);

export async function resolve(specifier, context, nextResolve) {
  const name = specifier.split('/').pop();
  if (STUBBED.has(name)) return { url: STUB, shortCircuit: true };
  return nextResolve(specifier, context);
}
