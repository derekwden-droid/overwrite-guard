// Runs scripts/overwrite-guard.mjs the way Claude Code does: PreToolUse input as JSON on
// stdin, reply as JSON on stdout.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assess, decide, handleWrite } from '../scripts/lib/hook.mjs';
import { jsonl, readRows, toolUse } from './fixtures.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/overwrite-guard.mjs', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overwrite-guard-hook-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let count = 0;
function file(name, text) {
  count += 1;
  const p = path.join(root, String(count), name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

function transcript(rows) {
  count += 1;
  const p = path.join(root, 'session-' + count + '.jsonl');
  fs.writeFileSync(p, jsonl(rows));
  return p;
}

function writeInput(target, content, transcriptPath, extra = {}) {
  return {
    session_id: 'test', transcript_path: transcriptPath, cwd: root, hook_event_name: 'PreToolUse',
    tool_name: 'Write', tool_input: { file_path: target, content }, tool_use_id: 'toolu_write', ...extra,
  };
}

function run(input) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { SystemRoot: process.env.SystemRoot },
  });
  return { status: result.status, stderr: result.stderr, reply: result.stdout ? JSON.parse(result.stdout) : null };
}

const SETTINGS = Array.from({ length: 300 }, (_, i) => 'option_' + (i + 1) + ' = ' + ((i * 37) % 101));
const SETTINGS_TEXT = SETTINGS.join('\n') + '\n';

test('blocks the reproduced case: 20 lines read, 295 lines replaced by a placeholder', () => {
  const target = file('settings.py', SETTINGS_TEXT);
  const tp = transcript(readRows(target, SETTINGS, 1, 20));
  const content = 'option_1 = 0\noption_2 = 37\noption_3 = 74\n# ... rest of the settings unchanged ...\noption_301 = 5\n';
  const { status, reply } = run(writeInput(target, content, tp));
  assert.equal(status, 0);
  const out = reply.hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /delete 280 lines of settings\.py that you have not read/);
  assert.match(out.permissionDecisionReason, /lines 21-300 of 300/);
  assert.match(out.permissionDecisionReason, /Line 4 of your new content, "# \.\.\. rest of the settings unchanged \.\.\.", is a placeholder/);
});

test('blocks a rewrite after a partial Read even without a placeholder', () => {
  const target = file('notes.md', SETTINGS_TEXT);
  const tp = transcript(readRows(target, SETTINGS, 1, 50));
  const content = SETTINGS.slice(0, 50).join('\n') + '\nnew line\n';
  const { reply } = run(writeInput(target, content, tp));
  assert.equal(reply.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reply.hookSpecificOutput.permissionDecisionReason, /delete 250 lines/);
  assert.match(reply.hookSpecificOutput.permissionDecisionReason, /Read the rest of the file first/);
});

test('lets a rewrite through once the whole file has been read', () => {
  const target = file('settings.py', SETTINGS_TEXT);
  const tp = transcript([...readRows(target, SETTINGS, 1, 150), ...readRows(target, SETTINGS, 151, 150)]);
  const content = SETTINGS.filter((_, i) => i % 3 !== 0).join('\n') + '\n';
  const { status, reply, stderr } = run(writeInput(target, content, tp));
  assert.equal(status, 0, stderr);
  assert.equal(reply, null);
});

test('blocks a placeholder even when Claude read the whole file', () => {
  const target = file('app.js', SETTINGS.map((l) => 'const ' + l + ';').join('\n') + '\n');
  const tp = transcript(readRows(target, SETTINGS.map((l) => 'const ' + l + ';')));
  const content = 'const option_1 = 0;\n// ... existing code ...\nconst ' + SETTINGS[299] + ';\nconst extra = 1;\n';
  const { reply } = run(writeInput(target, content, tp));
  assert.equal(reply.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reply.hookSpecificOutput.permissionDecisionReason, /line 2 of your new content, "\/\/ \.\.\. existing code \.\.\.", is a placeholder for text that is in app\.js now, and the Write would delete 298 lines \(lines 2-299\)/);
});

test('asks before replacing nearly all of a file Claude has read', () => {
  const target = file('devlog.md', SETTINGS_TEXT);
  const tp = transcript(readRows(target, SETTINGS));
  const { reply } = run(writeInput(target, '# Devlog\n\nStarted over today.\n', tp));
  assert.equal(reply.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(reply.hookSpecificOutput.permissionDecisionReason, /replaces nearly all of devlog\.md\. Only 0 of its 300 lines/);
});

test('stays quiet for new files, small files and additions', () => {
  const tp = transcript([]);
  assert.equal(run(writeInput(path.join(root, 'new.txt'), 'hello\n', tp)).reply, null);
  const small = file('small.txt', Array.from({ length: 15 }, (_, i) => 'line ' + i).join('\n'));
  assert.equal(run(writeInput(small, 'replaced\n', tp)).reply, null);
  const grow = file('grow.py', SETTINGS_TEXT);
  assert.equal(run(writeInput(grow, SETTINGS_TEXT + 'option_301 = 1\n', tp)).reply, null);
});

test('stays quiet when the deletions are below the threshold', () => {
  const target = file('few.py', SETTINGS_TEXT);
  const tp = transcript(readRows(target, SETTINGS, 1, 20));
  const content = SETTINGS.filter((_, i) => i < 290).join('\n') + '\n';
  assert.equal(run(writeInput(target, content, tp)).reply, null);
});

test('ignores tools other than Write', () => {
  const target = file('edit.py', SETTINGS_TEXT);
  const { status, reply } = run({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: target, old_string: 'a', new_string: 'b' } });
  assert.equal(status, 0);
  assert.equal(reply, null);
});

test('without a transcript, still catches placeholders and near-total rewrites', () => {
  const target = file('none.py', SETTINGS_TEXT);
  const missing = path.join(root, 'missing.jsonl');
  const placeholder = run(writeInput(target, 'option_1 = 0\n# ... unchanged ...\n', missing));
  assert.equal(placeholder.reply.hookSpecificOutput.permissionDecision, 'deny');
  const rewrite = run(writeInput(target, 'all new\n', missing));
  assert.equal(rewrite.reply.hookSpecificOutput.permissionDecision, 'ask');
  const partial = run(writeInput(target, SETTINGS.slice(0, 100).join('\n'), missing));
  assert.equal(partial.reply, null);
});

test('in a subagent, uses the subagent\'s own transcript', () => {
  const target = file('agent.py', SETTINGS_TEXT);
  const main = transcript(readRows(target, SETTINGS));
  const own = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents', 'agent-a1.jsonl');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, jsonl(readRows(target, SETTINGS, 1, 10)));
  const content = SETTINGS.slice(0, 100).join('\n');
  assert.equal(run(writeInput(target, content, main)).reply, null);
  assert.equal(run(writeInput(target, content, main, { agent_id: 'a1' })).reply.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run(writeInput(target, content, main, { agent_id: 'a2' })).reply, null);
});

test('reads UTF-16 and CRLF files', () => {
  const crlf = file('crlf.txt', SETTINGS.join('\r\n') + '\r\n');
  const tp = transcript(readRows(crlf, SETTINGS, 1, 20));
  assert.equal(run(writeInput(crlf, 'x = 1\n', tp)).reply.hookSpecificOutput.permissionDecision, 'deny');
  const wide = path.join(root, 'wide.txt');
  fs.writeFileSync(wide, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SETTINGS_TEXT, 'utf16le')]));
  const tp2 = transcript(readRows(wide, SETTINGS, 1, 20));
  assert.equal(run(writeInput(wide, 'x = 1\n', tp2)).reply.hookSpecificOutput.permissionDecision, 'deny');
});

test('skips binary files and notebooks', () => {
  const bin = file('blob.bin', Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x81, 0xfe, 0x00, 0x00, 0xc3]));
  const tp = transcript([]);
  assert.equal(run(writeInput(bin, 'x\n', tp)).reply, null);
  const nb = file('book.ipynb', SETTINGS_TEXT);
  assert.equal(run(writeInput(nb, '{}\n', tp)).reply, null);
});

test('fails open: malformed input exits 1 without a decision', () => {
  const { status, reply, stderr } = run('{"tool_name": "Write", broken');
  assert.equal(status, 1);
  assert.equal(reply, null);
  assert.match(stderr, /^overwrite-guard: /);
});

test('looks again when the transcript grows before blocking', async () => {
  const target = file('late.py', SETTINGS_TEXT);
  const tp = transcript(readRows(target, SETTINGS, 1, 20));
  const content = SETTINGS.slice(0, 100).join('\n');
  const pending = handleWrite(writeInput(target, content, tp), { settleMs: 200 });
  setTimeout(() => fs.appendFileSync(tp, jsonl(readRows(target, SETTINGS, 21, 280))), 50);
  assert.equal(await pending, null);
});

test('decide() needs a minimum share of unseen lines before blocking', () => {
  const lines = Array.from({ length: 400 }, (_, i) => 'row ' + i);
  const a = assess(lines.join('\n'), lines.slice(0, 370).join('\n'));
  assert.equal(a.unseenLimit, 20);
  const seenSome = new Set(lines.slice(0, 381));
  assert.equal(decide(a, seenSome, 'x.txt'), null);
  const seenFewer = new Set(lines.slice(0, 380));
  assert.equal(decide(a, seenFewer, 'x.txt').hookSpecificOutput.permissionDecision, 'deny');
});
