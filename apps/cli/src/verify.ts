/**
 * The bundle's signature (SPEC-006 §6): Ed25519 over the exact bytes of the
 * body, `RunOnRoad-Signature: keyid="<kid>", sig="<base64url>"`, checked with
 * the keys pinned at `ror login`. The bytes are verified BEFORE they are parsed.
 */
import { createPublicKey, verify } from 'node:crypto';

import type { SigningKey } from '@runonroad/api-contract';

export class SignatureError extends Error {
  override readonly name = 'SignatureError';
}

const HEADER = /^keyid="([^"]+)",\s*sig="([A-Za-z0-9_-]+)"$/u;

export function verifyBody(
  body: Uint8Array,
  header: string | null,
  keys: readonly SigningKey[],
): void {
  const match = header === null ? null : HEADER.exec(header.trim());
  if (match === null) throw new SignatureError('the signature header is missing or malformed');
  const key = keys.find((candidate) => candidate.kid === match[1]);
  if (key === undefined) throw new SignatureError(`unknown signing key ${match[1] ?? ''}`);
  const publicKey = createPublicKey({ key: { ...key }, format: 'jwk' });
  const ok = verify(null, body, publicKey, Buffer.from(match[2] ?? '', 'base64url'));
  if (!ok) throw new SignatureError('the signature does not match the bundle');
}
