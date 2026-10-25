import {
  SIGNATURE_HEADER
} from "./chunk-TSSXVKCL.js";

// src/harness-bundle.ts
import { z } from "zod";
var rootedPath = z.string().meta({
  description: "Starts with a path root the CLI resolves: ${project}, ${home}, \u2026 (SPEC-006 \xA72).",
  example: "${project}/.claude/rules/ror-hello--context.md"
});
var mergeStrategy = z.enum(["set", "append_unique", "remove"]);
var OperationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("write_file"),
    path: rootedPath,
    content: z.string(),
    executable: z.boolean().optional()
  }).meta({ id: "WriteFileOperation" }),
  z.strictObject({ op: z.literal("ensure_dir"), path: rootedPath }).meta({ id: "EnsureDirOperation" }),
  z.strictObject({
    op: z.literal("managed_block"),
    path: rootedPath,
    block_id: z.string(),
    content: z.string(),
    comment_style: z.enum(["html", "hash", "slash"])
  }).meta({ id: "ManagedBlockOperation" }),
  z.strictObject({
    op: z.literal("merge_json"),
    path: rootedPath,
    pointer: z.string().meta({ description: "RFC 6901 JSON pointer." }),
    value: z.unknown(),
    strategy: mergeStrategy,
    owner: z.string()
  }).meta({ id: "MergeJsonOperation" }),
  z.strictObject({
    op: z.literal("merge_toml"),
    path: rootedPath,
    table: z.string(),
    value: z.unknown(),
    strategy: mergeStrategy
  }).meta({ id: "MergeTomlOperation" }),
  z.strictObject({ op: z.literal("git_exclude"), pattern: z.string() }).meta({ id: "GitExcludeOperation" }),
  z.strictObject({
    op: z.literal("run_tool_command"),
    argv: z.array(z.string()).readonly().meta({ description: "Allow-listed per target; never a shell string." })
  }).meta({ id: "RunToolCommandOperation" }),
  z.strictObject({
    op: z.literal("remove_managed"),
    path: rootedPath.optional(),
    block_id: z.string().optional(),
    owner: z.string().optional()
  }).meta({ id: "RemoveManagedOperation" })
]).meta({ id: "Operation", description: "One operation of the closed vocabulary (SPEC-006 \xA72)." });
var ficheExamples = z.array(z.string().min(1).max(300)).max(12);
var RuleFicheSchema = z.strictObject({
  schema_version: z.literal(1),
  matcher_version: z.string().min(1).max(60).meta({ example: "content-matcher/1" }),
  interpretation: z.string().min(1).max(2e3),
  examples: z.strictObject({
    violation: ficheExamples,
    compliant: ficheExamples,
    other_subject: ficheExamples,
    ambiguous: ficheExamples
  }),
  tests: z.array(
    z.strictObject({
      text: z.string().min(1).max(500),
      expected: z.enum(["violation", "ambiguous", "none"])
    })
  ).min(1).max(60),
  origin: z.enum(["form", "assisted"]),
  approval: z.strictObject({
    by: z.string().min(1).max(100),
    at: z.iso.datetime(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u)
  }).optional().meta({
    description: "Written by the server only, when the author approves the exact rule and fiche and sealed at publication."
  })
}).meta({ id: "RuleFiche" });
var policyRuleBase = {
  id: z.string().meta({ example: "secure-coding:no-secrets-dir" }),
  source: z.string().meta({ example: "secure-coding@1.3.0" }),
  decision: z.enum(["forbid", "ask"]),
  reason: z.string(),
  required: z.boolean()
};
var PolicyRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...policyRuleBase,
    kind: z.literal("path"),
    access: z.enum(["read", "write", "any"]),
    glob: z.string()
  }),
  z.strictObject({
    ...policyRuleBase,
    kind: z.literal("command"),
    executable: z.string(),
    argv_prefix: z.array(z.string()).readonly(),
    flags_any: z.array(z.string()).readonly()
  }),
  z.strictObject({
    ...policyRuleBase,
    kind: z.literal("content"),
    topic: z.string(),
    text: z.string(),
    subject_aliases: z.array(z.string()).readonly(),
    scopes: z.array(z.enum(["prompt", "file_write", "answer"])).readonly(),
    constraint: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("number_bound"),
        operator: z.enum(["lt", "lte", "gt", "gte"]),
        limit: z.string().meta({ description: "A decimal string; the PERMITTED value is `operator` `limit`." }),
        unit: z.enum(["percent", "amount", "count"]),
        currency: z.string().optional(),
        binding_window: z.number().int()
      }),
      z.strictObject({
        kind: z.literal("forbidden_terms"),
        terms: z.array(z.string()).readonly(),
        context_exceptions: z.array(z.string()).readonly()
      })
    ]),
    mode: z.enum(["block", "review"]).meta({
      description: "`review`: the rule depends on a condition code cannot read, so a finding is handed to the conversation\u2019s AI instead of being blocked."
    }),
    alternatives: z.array(z.string()).readonly(),
    fiche: RuleFicheSchema.optional()
  })
]).meta({ id: "PolicyRule" });
var PolicySchema = z.strictObject({
  schema_version: z.literal(1),
  principal: z.string().nullable(),
  rules: z.array(PolicyRuleSchema).readonly(),
  mcp_allow: z.array(z.string()).readonly().meta({
    description: "MCP servers an agent may call; any other `mcp__` tool is denied by `ror hook`."
  }),
  derogations: z.array(
    z.strictObject({
      rule_id: z.string().meta({ example: "secure-coding@1.3.0:prod-db" }),
      expires_at: z.iso.datetime()
    })
  ).readonly().optional().meta({
    description: "Ask-first rules lifted for this person until `expires_at` (ADR-0116), sorted by rule. The rules stay in `rules`: `ror hook` allows one only while its lease runs, by its own clock."
  })
}).meta({ id: "Policy" });
var HarnessBundleSchema = z.object({
  bundle_version: z.literal(1),
  organization_id: z.string().meta({ example: "org_01J9Z3K8QXV4WN7YBTR2M6ACDE" }),
  target: z.enum(["claude_code", "codex", "cursor"]),
  layer: z.enum(["user", "project"]),
  project_id: z.string().nullable(),
  effective_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/u).meta({ description: "Also the ETag. Excludes issued_at (SPEC-006 \xA75)." }),
  capability_matrix_version: z.string(),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime().nullable(),
  operations: z.array(OperationSchema).readonly(),
  policy: PolicySchema.optional().meta({
    description: "Present only when a governance carries enforceable rules (ADR-0114)."
  }),
  degraded: z.array(z.object({ component: z.string(), support: z.string(), reason: z.string() })).readonly(),
  warnings: z.array(
    z.object({
      code: z.enum(["DOMAIN_DISABLED"]),
      governance: z.string().meta({ example: "legal-contracts" }),
      domain: z.string().meta({ example: "legal" })
    })
  ).readonly().meta({ description: "Governances left out by the resolution, and why (SPEC-004 \xA77)." }),
  provenance: z.array(
    z.object({
      governance: z.string().meta({ example: "hello" }),
      version: z.string().meta({ example: "1.0.0" }),
      document_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      assignment_id: z.string().nullable(),
      layer: z.string().meta({ example: "org" })
    })
  ).readonly()
}).meta({
  id: "HarnessBundle",
  description: "SPEC-006 \xA71. The response body is exactly the RFC 8785 (JCS) bytes that the RunOnRoad-Signature header signs: verify the bytes before parsing them."
});
var SKILL_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,5}$/u;
var SkillFileSchema = z.strictObject({
  path: z.string().max(200).regex(SKILL_PATH_PATTERN).meta({ example: "references/guide.md" }),
  content: z.string().max(262144)
}).meta({ id: "SkillFile" });
var LibraryDocumentSchema = z.strictObject({
  library_version: z.literal(1),
  organization_id: z.string(),
  member_id: z.string().describe("Whose library this is: a device checks it is its own."),
  issued_at: z.iso.datetime(),
  skills: z.array(
    z.strictObject({
      id: z.string(),
      slug: z.string(),
      folder: z.string().meta({ example: "ror-lib-devis" }),
      name: z.string(),
      description: z.string(),
      revision: z.int(),
      tree_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      enabled: z.boolean(),
      files: z.array(SkillFileSchema)
    })
  ),
  removed: z.array(z.string()).describe("Ids of skills deleted since: remove their folder.")
}).meta({
  id: "LibraryDocument",
  description: "The person\u2019s library as a device applies it. The body is the exact RFC 8785 bytes the RunOnRoad-Signature header signs. Only exposed, conformant revisions carry their files."
});
export {
  HarnessBundleSchema,
  LibraryDocumentSchema,
  SIGNATURE_HEADER
};
