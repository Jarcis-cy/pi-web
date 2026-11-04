/**
 * Session persona: a new session may start as one of the user's Agent
 * definitions (pi-web "identity switch"). The persona's system prompt is
 * appended to the session's system prompt, and a custom entry persists it so
 * restarts re-apply the identity without re-reading the profile file.
 */

import type { SubagentProfile } from "./subagents";

export const PERSONA_META_TYPE = "pi-web:persona";

export interface PersonaMetadata {
  version: 1;
  personaId: string;
  displayName: string;
  appendSystemPrompt: string;
  createdAt: string;
}

/** The persona a session's entries carry, or null when it has none. */
export function readPersonaMetadata(
  entries: readonly { type: string; customType?: string; data?: unknown }[],
): PersonaMetadata | null {
  const entry = entries.find((item) => item.type === "custom" && item.customType === PERSONA_META_TYPE);
  if (!entry || typeof entry.data !== "object" || entry.data === null) return null;
  const data = entry.data as Partial<PersonaMetadata>;
  if (
    data.version !== 1
    || typeof data.personaId !== "string"
    || typeof data.displayName !== "string"
    || typeof data.appendSystemPrompt !== "string"
    || typeof data.createdAt !== "string"
  ) {
    return null;
  }
  return data as PersonaMetadata;
}

/** The append-prompt for a persona session: the agent definition's prompt,
 *  followed by the expert-memory pointer block. Pure and testable. */
export function buildPersonaAppendSystemPrompt(
  profile: Pick<SubagentProfile, "systemPrompt" | "name">,
  options: { expertBaseDir: string; projectName: string },
): string {
  const memoryBlock = [
    "",
    "--- 专家记忆区 ---",
    `你的专家记忆区：${options.expertBaseDir}/${profile.name}/projects/${options.projectName}/STATE.md`,
    "开工先读它；文件或目录不存在时，按你人设中关于项目层的规则初始化一套",
    `（STATE/LOG/DECISIONS/refs 建在 ${options.expertBaseDir}/${profile.name}/projects/${options.projectName}/ 下）。`,
    `跨项目经验记入 ${options.expertBaseDir}/${profile.name}/CRAFT.md（每条一行并标注来源项目）。`,
    "",
  ].join("\n");
  return `${profile.systemPrompt.trim()}\n${memoryBlock}`;
}
