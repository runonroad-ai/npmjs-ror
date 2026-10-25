// The hook bundle never reads `config.yaml`: this stands in for `yaml` there, so that the library
// (260 KB) is not compiled on every tool call (ADR-0008). The build of `dist/hook-main.js` aliases it.
const refused = (): never => {
  throw new Error('the hook does not read YAML');
};
export const parse = refused;
export const stringify = refused;
