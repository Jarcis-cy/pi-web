import { NextResponse } from "next/server";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { startRpcSession } from "@/lib/rpc-manager";
import { resolveSubagentProfile } from "@/lib/subagents";
import { buildPersonaAppendSystemPrompt } from "@/lib/persona-session";
import { cwdMissingBody } from "@/lib/missing-cwd";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);


/** Expert memory base dir: the memory plugin's configured expertBaseDir when
 *  present, else <agentRoot>/experts. Wrong bases degrade gracefully (the
 *  appended prompt says to self-initialize when the path is missing). */
function personaExpertBaseDir(): string {
  const agentRoot = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  try {
    const config = JSON.parse(readFileSync(path.join(agentRoot, "hermes-memory-config.json"), "utf-8")) as { expertBaseDir?: string };
    if (typeof config.expertBaseDir === "string" && config.expertBaseDir) return config.expertBaseDir;
  } catch {
    // no config or unreadable: fall through to the default
  }
  return path.join(agentRoot, "experts");
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
export async function POST(req: Request) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({
        ...cwdMissingBody(cwd),
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, personaId, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; personaId?: unknown; [key: string]: unknown };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);

    // Persona: start the session AS one of the user's Agent definitions. The
    // definition's prompt is appended to the system prompt (plus an
    // expert-memory pointer); the choice is persisted with the session.
    let persona: { personaId: string; displayName: string; appendSystemPrompt: string } | undefined;
    let personaToolNames: string[] | undefined;
    if (personaId !== undefined && personaId !== null && personaId !== "") {
      if (typeof personaId !== "string") throw new Error("personaId must be a string");
      const profile = resolveSubagentProfile(cwd, personaId);
      if (!profile) throw new Error(`Unknown persona: ${personaId}`);
      persona = {
        personaId: profile.name,
        displayName: profile.displayName || profile.name,
        appendSystemPrompt: buildPersonaAppendSystemPrompt(profile, {
          expertBaseDir: personaExpertBaseDir(),
          projectName: path.basename(cwd),
        }),
      };
      // The persona's tool whitelist applies unless the caller pinned tools.
      if (!toolNames && profile.tools.length > 0) personaToolNames = [...profile.tools];
    }

    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session. Date.now() (ms resolution) collides for
    // requests in the same millisecond, merging two new sessions into one.
    const tempKey = `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
      ...(toolNames ?? personaToolNames ? { toolNames: toolNames ?? personaToolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
      ...(persona ? { persona } : {}),
    });

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(cwd);
    invalidateSessionListCache();

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
    };

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
      });
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";

    return NextResponse.json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}
