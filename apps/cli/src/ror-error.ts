/**
 * Apart from the keychain store, so a module on the hook's path (`state.ts`) can throw it without
 * bundling `@napi-rs/keyring` into `ror hook` (ADR-0008).
 */

/** An error `ror` prints with its stable `ROR-Ennn` code (SPEC-007 §1). */
export class RorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code} ${message}`, options);
    this.name = 'RorError';
  }
}
