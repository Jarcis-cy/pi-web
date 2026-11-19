import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetDiagnosticsForTest,
  childProcesses,
  diag,
  diagToolEnd,
  diagToolStart,
  flushDiagnostics,
  parseProcStat,
  sanitizeDiagFields,
  shouldReportStuck,
} from "./diagnostics.ts";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pi-web-diag-"));
}

test("parseProcStat keeps a comm with spaces and parentheses apart from state and ppid", () => {
  assert.deepEqual(parseProcStat("123 (bash (x)) S 42 99"), { pid: 123, comm: "bash (x)", state: "S", ppid: 42 });
  assert.deepEqual(parseProcStat("7 (rm) D 1 2"), { pid: 7, comm: "rm", state: "D", ppid: 1 });
  assert.equal(parseProcStat("garbage"), null);
  assert.equal(parseProcStat(""), null);
});

test("shouldReportStuck needs both an old tool and a fresh reporting gap", () => {
  assert.equal(shouldReportStuck({ ageMs: 10, sinceLastReportMs: 10 }), false);
  assert.equal(shouldReportStuck({ ageMs: 130_000, sinceLastReportMs: 1_000 }), false);
  assert.equal(shouldReportStuck({ ageMs: 130_000, sinceLastReportMs: 61_000 }), true);
  assert.equal(shouldReportStuck({ ageMs: 5_000, sinceLastReportMs: 999_999, thresholdMs: 1_000, repeatMs: 1_000 }), true);
});

test("sanitizeDiagFields keeps scalars, truncates long strings and drops undefined", () => {
  const fields = sanitizeDiagFields({ a: 1, b: "x".repeat(600), c: { d: 2 }, e: [1, 2, 3], f: undefined });
  assert.equal(fields.a, 1);
  assert.ok(String(fields.b).length <= 501, "long strings are cut at the limit");
  assert.deepEqual(fields.c, { d: 2 });
  assert.deepEqual(fields.e, [1, 2, 3]);
  assert.equal("f" in fields, false);
});

test("diag writes one JSON line per event into a day file", async () => {
  const dir = tempDir();
  process.env.PI_WEB_DIAG = "1";
  process.env.PI_WEB_DIAG_DIR = dir;
  __resetDiagnosticsForTest();
  diag("test_event", { value: 1 });
  diagToolStart("s1", "c1", "bash");
  diagToolEnd("s1", "c1", "bash", false, 5);
  await flushDiagnostics();
  const files = readdirSync(dir).filter((name) => name.endsWith(".ndjson"));
  assert.equal(files.length, 1);
  const rows = readFileSync(join(dir, files[0]), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.event), ["test_event", "tool_start", "tool_end"]);
  assert.equal(rows[0].value, 1);
  assert.equal(typeof rows[0].ts, "string");
  assert.equal(rows[2].durationMs, 5);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PI_WEB_DIAG_DIR;
});

test("disabled diagnostics write nothing and never throw", async () => {
  const dir = tempDir();
  process.env.PI_WEB_DIAG = "0";
  process.env.PI_WEB_DIAG_DIR = dir;
  __resetDiagnosticsForTest();
  diag("ignored");
  diagToolStart("s", "c", "bash");
  await flushDiagnostics();
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
  process.env.PI_WEB_DIAG = "1";
  delete process.env.PI_WEB_DIAG_DIR;
});

test("childProcesses lists a live child with its state and cmdline", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn("sleep", ["3"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rows = childProcesses();
    assert.ok(Array.isArray(rows), "Linux exposes /proc children");
    const row = rows.find((entry) => entry.pid === child.pid);
    assert.ok(row, `sleep child ${child.pid} is listed`);
    assert.equal(row.state, "S");
    assert.match(String(row.cmdline), /^sleep 3/);
  } finally {
    child.kill("SIGKILL");
  }
});
