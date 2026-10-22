// src/device-token.ts
import { z } from "zod";
var SigningKeySchema = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string(),
  kid: z.string(),
  use: z.literal("sig"),
  alg: z.literal("EdDSA")
}).meta({ id: "SigningKey" });
var DeviceTokenSchema = z.object({
  device_token: z.string().regex(/^rord_[A-Za-z0-9_-]{43}$/u).meta({
    description: "The device token, shown once: kept by `ror` in the keychain of the system, sent as a Bearer credential. RunOnRoad keeps its SHA-256 only."
  }),
  device_id: z.string().regex(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/u).meta({ example: "dev_01J9Z3K8QXV4WN7YBTR2M6ACDE" }),
  organization_id: z.string().meta({ example: "org_01J9Z3K8QXV4WN7YBTR2M6ACDE" }),
  signing_public_keys: z.array(SigningKeySchema).meta({
    description: "The public keys of the organization, to pin: every bundle is verified with them."
  })
}).meta({ id: "DeviceToken" });
export {
  DeviceTokenSchema
};
