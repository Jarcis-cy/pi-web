/**
 * Durable incident tracing for the server process.
 *
 * Why this exists: a run can stop between an assistant's tool call and its tool result
 * (2026-11-18: two subagent sessions, nobody could say afterwards whether the bash child was
 * alive, where it waited, or whether the tool result was lost when a wrapper closed). stderr went
 * to a terminal, the journal was empty, the process never restarted and the child processes were
 * gone by the time anyone looked. This module writes one JSON line per lifecycle event to a file
 * that outlives the server, and while a tool call is in flight it samples the process tree, the
 * event loop and the temp directory, so the next occurrence leaves a trace.
 *
 * Privacy: ids, names, counts, durations, pids and kernel states only. Never message text, prompts,
 * file contents or tool arguments. Set PI_WEB_DIAG_ARGS=1 to include a truncated bash command when
 * that tradeoff is acceptable for an investigation.
 *
 * Failure policy: diagnostics never throw, never block a request and never keep the process alive.
 * Write errors fall back to one console line a minute; a full queue drops its oldest rows.
 *
 * Env: PI_WEB_DIAG=0 disables, PI_WEB_DIAG_DIR overrides the directory (default
 * `<agent dir>/pi-web-diag`), PI_WEB_DIAG_STUCK_MS and PI_WEB_DIAG_REPEAT_MS tune the in-flight
 * watchdog, PI_WEB_DIAG_KEEP_DAYS prunes day files.
 */
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

const DEFAULT_STUCK_MS = 120_000;
const DEFAULT_REPEAT_MS = 60_000;
const DEFAULT_KEEP_DAYS = 7;
const WATCHDOG_INTERVAL_MS = 30_000;
const LOOP_LAG_INTERVAL_MS = 5_000;
const LOOP_LAG_REPORT_MS = 1_000;
const LOOP_LAG_REPEAT_MS = 10_000;
const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const MAX_QUEUE = 5_000;
const MAX_STRING = 500;
const MAX_ARRAY = 20;
const MAX_DEPTH = 2;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

interface InFlightTool {
  sessionId: string;
  toolName: string;
  startedAt: number;
  lastReportAt: number;
}

const inFlight = new Map<string, InFlightTool>();
let watchdogStarted = false;
let loopMonitor: IntervalHistogram | undefined;
let lastLoopReportAt = 0;
let queue: string[] = [];
let flushing = false;
let droppedRows = 0;
let lastWriteErrorAt = 0;
let readyDir: string | undefined;
let prunedDir: string | undefined;
let bytesDay: string | undefined;
let bytesToday = 0;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function diagEnabled(): boolean {
  return process.env.PI_WEB_DIAG !== "0";
}

function diagDirectory(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return process.env.PI_WEB_DIAG_DIR || join(agentDir, "pi-web-diag");
}

function diagFile(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return join(diagDirectory(), `diag-${day}.ndjson`);
}

/** One value, reduced to what the file may hold: scalars, short strings, small shallow shapes. */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (Array.isArray(value)) {
    return depth >= MAX_DEPTH ? `[${value.length}]` : value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "[object]";
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ARRAY)) {
      out[key] = sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** The fields of one diagnostic row, sanitized. Exported for tests. */
export function sanitizeDiagFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = sanitizeValue(value, 0);
  }
  return out;
}

/** Only `comm` may contain spaces and parentheses; pid, state and ppid sit around it. Linux only. */
export function parseProcStat(text: string): { pid: number; comm: string; state: string; ppid: number } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const comm = text.slice(open + 1, close);
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const state = rest[0];
  const ppid = Number(rest[1]);
  if (!Number.isInteger(pid) || pid <= 0 || !state) return null;
  return { pid, comm, state, ppid: Number.isInteger(ppid) ? ppid : -1 };
}

/** Whether an in-flight tool should be reported again: old enough, and not reported recently. */
export function shouldReportStuck(input: {
  ageMs: number;
  sinceLastReportMs: number;
  thresholdMs?: number;
  repeatMs?: number;
}): boolean {
  const threshold = input.thresholdMs ?? DEFAULT_STUCK_MS;
  const repeat = input.repeatMs ?? DEFAULT_REPEAT_MS;
  return input.ageMs >= threshold && input.sinceLastReportMs >= repeat;
}

function fdCount(): number | undefined {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return undefined;
  }
}

function threadCount(): number | undefined {
  try {
    return readdirSync("/proc/self/task").length;
  } catch {
    return undefined;
  }
}

/** `statfs` for the temp directory: inode exhaustion there is a known failure input. */
function tempStats(): Record<string, unknown> | undefined {
  try {
    const stats = statfsSync(process.env.TMPDIR || "/tmp");
    return {
      dir: process.env.TMPDIR || "/tmp",
      freeBytes: stats.bfree * stats.bsize,
      freeInodes: stats.ffree,
      totalInodes: stats.files,
    };
  } catch {
    return undefined;
  }
}

/**
 * Direct children of this process, with the fields that tell a live-but-waiting child from a
 * zombie: /proc state, wchan, cmdline and RSS. Linux only; a child that already exited is skipped.
 */
export function childProcesses(limit = 30): Record<string, unknown>[] | undefined {
  if (process.platform !== "linux") return undefined;
  const pids = new Set<number>();
  try {
    for (const tid of readdirSync("/proc/self/task")) {
      const raw = readFileSync(`/proc/self/task/${tid}/children`, "utf8").trim();
      for (const part of raw.split(/\s+/)) {
        const pid = Number(part);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    }
  } catch {
    return undefined;
  }
  const rows: Record<string, unknown>[] = [];
  for (const pid of [...pids].slice(0, limit)) {
    try {
      const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (!stat) continue;
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ").slice(0, 200);
      let wchan: string | undefined;
      try {
        wchan = readFileSync(`/proc/${pid}/wchan`, "utf8").trim() || undefined;
      } catch {
        wchan = undefined;
      }
      let rssKb: number | undefined;
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const match = /VmRSS:\s+(\d+) kB/.exec(status);
        rssKb = match ? Number(match[1]) : undefined;
      } catch {
        rssKb = undefined;
      }
      rows.push({ pid: stat.pid, ppid: stat.ppid, state: stat.state, comm: stat.comm.slice(0, 60), wchan, rssKb, cmdline });
    } catch {
      // The child exited between listing and reading it: not evidence, skip it.
    }
  }
  return rows;
}

function processSnapshot(): Record<string, unknown> {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    fdCount: fdCount(),
    threadCount: threadCount(),
    inFlightTools: inFlight.size,
  };
}

async function ensureDirectory(dir: string): Promise<void> {
  if (readyDir === dir) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  readyDir = dir;
}

/** Remove day files past PI_WEB_DIAG_KEEP_DAYS. One attempt per directory per process. */
async function pruneOldFiles(dir: string): Promise<void> {
  if (prunedDir === dir) return;
  prunedDir = dir;
  const keepDays = envInt("PI_WEB_DIAG_KEEP_DAYS", DEFAULT_KEEP_DAYS);
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  try {
    for (const name of await readdir(dir)) {
      const match = /^diag-(\d{4})(\d{2})(\d{2})\.ndjson$/.exec(name);
      if (!match) continue;
      const stamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (stamp >= cutoff) continue;
      await unlink(join(dir, name)).catch(() => undefined);
    }
  } catch {
    // No directory yet, or not ours to prune: the write path reports its own errors.
  }
}

async function flushQueue(): Promise<void> {
  flushing = true;
  try {
    while (queue.length > 0) {
      const chunk = queue.splice(0, 200).join("");
      const file = diagFile();
      if (file !== bytesDay) {
        bytesDay = file;
        bytesToday = 0;
      }
      if (bytesToday > MAX_FILE_BYTES) continue;
      try {
        const dir = diagDirectory();
        await ensureDirectory(dir);
        await appendFile(file, chunk, { mode: 0o600 });
        bytesToday += chunk.length;
        if (droppedRows > 0) {
          droppedRows = 0;
          queue.unshift(`${JSON.stringify({ ts: new Date().toISOString(), event: "diag_queue_overflow" })}\n`);
        }
        void pruneOldFiles(dir);
      } catch (error) {
        if (Date.now() - lastWriteErrorAt > 60_000) {
          lastWriteErrorAt = Date.now();
          console.error("[pi-web] diagnostics write failed:", error instanceof Error ? error.message : error);
        }
      }
    }
  } finally {
    flushing = false;
  }
}

/** Append one diagnostic row. Safe to call anywhere: it never throws and never waits. */
export function diag(event: string, fields: Record<string, unknown> = {}): void {
  if (!diagEnabled()) return;
  try {
    queue.push(`${JSON.stringify({ ts: new Date().toISOString(), event, ...sanitizeDiagFields(fields) })}\n`);
    if (queue.length > MAX_QUEUE) {
      queue.splice(0, queue.length - MAX_QUEUE);
      droppedRows += 1;
    }
    if (!flushing) void flushQueue();
  } catch {
    // A diagnostic row must never break the caller.
  }
}

/** Wait for the queued rows to hit disk. For tests and shutdown; core paths never wait. */
export function flushDiagnostics(): Promise<void> {
  return flushing ? new Promise((resolve) => setTimeout(resolve, 20)).then(flushDiagnostics) : flushQueue();
}

/**
 * A tool call started. Kept until its end event (or the wrapper's close), so the watchdog can
 * report one that never returns.
 */
export function diagToolStart(sessionId: string, toolCallId: string, toolName: string, args?: unknown): void {
  if (!diagEnabled()) return;
  inFlight.set(toolCallId, { sessionId, toolName, startedAt: Date.now(), lastReportAt: 0 });
  const includeArgs = process.env.PI_WEB_DIAG_ARGS === "1" && toolName === "bash";
  diag("tool_start", {
    sessionId,
    toolCallId,
    toolName,
    inFlight: inFlight.size,
    ...(includeArgs ? { command: bashCommand(args) } : {}),
  });
  ensureWatchdog();
}

function bashCommand(args: unknown): string | undefined {
  try {
    const command = (args as { command?: unknown })?.command;
    return typeof command === "string" ? command.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

/** A tool call returned (or failed). */
export function diagToolEnd(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  isError: boolean,
  durationMs?: number,
): void {
  const entry = inFlight.get(toolCallId);
  inFlight.delete(toolCallId);
  if (!diagEnabled()) return;
  const now = Date.now();
  diag("tool_end", {
    sessionId,
    toolCallId,
    toolName,
    isError,
    durationMs: durationMs ?? (entry ? now - entry.startedAt : undefined),
    ageMs: entry ? now - entry.startedAt : undefined,
    inFlight: inFlight.size,
  });
}

/** Drop this session's in-flight tools without an end event: the result would have been lost. */
export function diagToolsCleared(sessionId: string, reason: string): void {
  if (!diagEnabled()) return;
  const now = Date.now();
  for (const [toolCallId, entry] of [...inFlight.entries()]) {
    if (entry.sessionId !== sessionId) continue;
    inFlight.delete(toolCallId);
    diag("tool_cleared", { sessionId, toolCallId, toolName: entry.toolName, ageMs: now - entry.startedAt, reason });
  }
}

/** A wrapper is being destroyed: what was still pending, and why it went away. */
export function diagWrapperClose(fields: {
  sessionId: string;
  pendingTools: string[];
  pendingPrompts: number;
  running: boolean;
  forcedIdle: boolean;
  ageMs?: number;
}): void {
  if (!diagEnabled()) return;
  diag("wrapper_close", {
    sessionId: fields.sessionId,
    pendingToolCount: fields.pendingTools.length,
    pendingTools: fields.pendingTools.slice(0, 10),
    pendingPrompts: fields.pendingPrompts,
    running: fields.running,
    forcedIdle: fields.forcedIdle,
    ageMs: fields.ageMs,
  });
  diagToolsCleared(fields.sessionId, "wrapper_close");
}

/** The idle timer's close/keep decision, with every input the guard used. */
export function diagIdleDecision(fields: {
  sessionId: string;
  decision: "close" | "keep";
  running: boolean;
  subagentStatus: string | null;
  liveness: boolean;
  forced: boolean;
  idleMs: number;
}): void {
  diag("idle_shutdown", { ...fields });
}

function ensureWatchdog(): void {
  if (watchdogStarted || !diagEnabled()) return;
  watchdogStarted = true;
  try {
    loopMonitor = monitorEventLoopDelay({ resolution: 200 });
    loopMonitor.enable();
  } catch {
    loopMonitor = undefined;
  }
  const watchdog = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();
  const loop = setInterval(loopLagTick, LOOP_LAG_INTERVAL_MS);
  loop.unref?.();
  const snapshot = setInterval(() => {
    if (inFlight.size === 0) return;
    diag("process_snapshot", { process: processSnapshot(), tmp: tempStats() });
  }, SNAPSHOT_INTERVAL_MS);
  snapshot.unref?.();
}

/** Report an event loop that stops serving: the difference between "one tool hangs" and "server hangs". */
function loopLagTick(): void {
  if (!loopMonitor || !diagEnabled()) return;
  const maxMs = loopMonitor.max / 1e6;
  const meanMs = loopMonitor.mean / 1e6;
  const p99Ms = loopMonitor.percentile(99) / 1e6;
  if (maxMs < LOOP_LAG_REPORT_MS || Date.now() - lastLoopReportAt < LOOP_LAG_REPEAT_MS) return;
  lastLoopReportAt = Date.now();
  diag("loop_lag", { maxMs: Math.round(maxMs), meanMs: Math.round(meanMs), p99Ms: Math.round(p99Ms), inFlightTools: inFlight.size });
  loopMonitor.reset();
}

function watchdogTick(): void {
  if (!diagEnabled()) return;
  const now = Date.now();
  const thresholdMs = envInt("PI_WEB_DIAG_STUCK_MS", DEFAULT_STUCK_MS);
  const repeatMs = envInt("PI_WEB_DIAG_REPEAT_MS", DEFAULT_REPEAT_MS);
  const stuck = [...inFlight.entries()].filter(([, entry]) => shouldReportStuck({
    ageMs: now - entry.startedAt,
    sinceLastReportMs: now - entry.lastReportAt,
    thresholdMs,
    repeatMs,
  }));
  if (stuck.length === 0) return;
  const children = childProcesses();
  const snapshot = { process: processSnapshot(), tmp: tempStats(), children };
  for (const [toolCallId, entry] of stuck) {
    entry.lastReportAt = now;
    diag("tool_stuck", {
      sessionId: entry.sessionId,
      toolCallId,
      toolName: entry.toolName,
      ageMs: now - entry.startedAt,
      inFlight: inFlight.size,
      ...snapshot,
    });
  }
}

/** For tests: reset the in-memory state so a fresh directory/environment can be used. */
export function __resetDiagnosticsForTest(): void {
  inFlight.clear();
  queue = [];
  bytesDay = undefined;
  bytesToday = 0;
  readyDir = undefined;
  prunedDir = undefined;
  droppedRows = 0;
}
