import { test } from "node:test";
import assert from "node:assert/strict";
import { readPersonaMetadata, buildPersonaAppendSystemPrompt, PERSONA_META_TYPE } from "./persona-session.ts";

test("readPersonaMetadata round-trips a valid entry and rejects malformed ones", () => {
  const valid = {
    type: "custom",
    customType: PERSONA_META_TYPE,
    data: { version: 1, personaId: "steward", displayName: "Steward", appendSystemPrompt: "prompt", createdAt: "2026-11-02T00:00:00Z" },
  };
  assert.equal(readPersonaMetadata([valid])?.personaId, "steward");
  assert.equal(readPersonaMetadata([]), null);
  assert.equal(readPersonaMetadata([{ type: "custom", customType: "other", data: valid.data }]), null);
  assert.equal(readPersonaMetadata([{ type: "custom", customType: PERSONA_META_TYPE, data: { version: 2 } }]), null);
  assert.equal(readPersonaMetadata([{ type: "custom", customType: PERSONA_META_TYPE, data: { version: 1, personaId: 5 } }]), null);
});

test("buildPersonaAppendSystemPrompt carries the persona prompt and the per-project expert memory pointer", () => {
  const append = buildPersonaAppendSystemPrompt(
    { name: "storage", systemPrompt: "你是存储治理专家。开工先读项目层 STATE。" },
    { expertBaseDir: "/ws/.agents", projectName: "code-audit" },
  );
  assert.match(append, /^你是存储治理专家/);
  assert.match(append, /\/ws\/\.agents\/storage\/AGENTS\.md/);
  assert.match(append, /\/ws\/\.agents\/storage\/projects\/code-audit\/STATE\.md/);
  assert.match(append, /CRAFT\.md/);
  assert.ok(!append.includes("<当前项目>"), "project name must be interpolated, not left as a placeholder");
});

test("persona memory pointer is per-project: a different project yields a different path", () => {
  const base = { name: "storage", systemPrompt: "x" };
  const a = buildPersonaAppendSystemPrompt(base, { expertBaseDir: "/ws/.agents", projectName: "code-audit" });
  const b = buildPersonaAppendSystemPrompt(base, { expertBaseDir: "/ws/.agents", projectName: "project-b" });
  assert.ok(a.includes("projects/code-audit/"));
  assert.ok(b.includes("projects/project-b/"));
  assert.notEqual(a, b);
});
