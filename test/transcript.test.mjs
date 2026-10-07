// Rebuilds the lines Claude saw from transcripts shaped like Claude Code's session JSONL.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePath, readTranscript, seenLines, transcriptFor } from '../scripts/lib/transcript.mjs';
import { jsonl, readRows, toolResult, toolUse, uuid } from './fixtures.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overwrite-guard-transcript-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const TARGET = path.join(root, 'proj', 'settings.py');
const OTHER = path.join(root, 'proj', 'other.py');
const LINES = Array.from({ length: 30 }, (_, i) => 'SETTING_' + (i + 1) + ' = ' + (i + 1) * 7);

test('counts the lines a partial Read showed, and only those', () => {
  const seen = seenLines(jsonl(readRows(TARGET, LINES, 1, 5)), TARGET);
  assert.ok(seen.has('SETTING_1 = 7'));
  assert.ok(seen.has('SETTING_5 = 35'));
  assert.ok(!seen.has('SETTING_6 = 42'));
});

test('reads the numbered tool result when there is no structured copy', () => {
  const seen = seenLines(jsonl(readRows(TARGET, LINES, 10, 3, false)), TARGET);
  assert.ok(seen.has('SETTING_10 = 70'));
  assert.ok(seen.has('SETTING_12 = 84'));
  assert.ok(!seen.has('SETTING_13 = 91'));
});

test('accepts the older arrow-numbered Read output', () => {
  const use = toolUse('Read', { file_path: TARGET });
  const arrow = String.fromCharCode(0x2192);
  const seen = seenLines(jsonl([use.row, toolResult(use.id, '     1' + arrow + 'alpha = 1\n     2' + arrow + 'beta = 2')]), TARGET);
  assert.ok(seen.has('alpha = 1'));
  assert.ok(seen.has('beta = 2'));
});

test('ignores Reads of other files', () => {
  const seen = seenLines(jsonl(readRows(OTHER, LINES)), TARGET);
  assert.ok(!seen.has('SETTING_1 = 7'));
});

test('counts earlier Writes and Edits to the file', () => {
  const rows = [
    toolUse('Write', { file_path: TARGET, content: 'written = 1\nwritten = 2\n' }).row,
    toolUse('Edit', { file_path: TARGET, old_string: 'before = 1', new_string: 'after = 1' }).row,
    toolUse('MultiEdit', { file_path: TARGET, edits: [{ old_string: 'multi_old', new_string: 'multi_new' }] }).row,
    toolUse('Write', { file_path: OTHER, content: 'elsewhere = 1' }).row,
  ];
  const seen = seenLines(jsonl(rows), TARGET);
  for (const key of ['written = 1', 'written = 2', 'before = 1', 'after = 1', 'multi_old', 'multi_new']) assert.ok(seen.has(key), key);
  assert.ok(!seen.has('elsewhere = 1'));
});

test('skips the Write being checked', () => {
  const use = toolUse('Write', { file_path: TARGET, content: 'new = 1' }, 'toolu_current');
  assert.ok(!seenLines(jsonl([use.row]), TARGET, { skipId: 'toolu_current' }).has('new = 1'));
});

test('counts shell and search output that named the file', () => {
  const cat = toolUse('Bash', { command: 'cat -n proj/settings.py' });
  const grep = toolUse('Bash', { command: 'grep -n SETTING_2 settings.py' });
  const search = toolUse('Grep', { pattern: 'SETTING_3', path: path.join(root, 'proj'), output_mode: 'content', '-n': true });
  const diff = toolUse('Bash', { command: 'git diff proj/settings.py' });
  const rows = [
    cat.row, toolResult(cat.id, '     1\tSETTING_1 = 7\n     2\tSETTING_2 = 14'),
    grep.row, toolResult(grep.id, '20:SETTING_20 = 140'),
    search.row, toolResult(search.id, TARGET + ':3:SETTING_3 = 21\n' + OTHER + ':9:SETTING_30 = 210'),
    diff.row, toolResult(diff.id, '--- a/proj/settings.py\n+++ b/proj/settings.py\n@@ -8,2 +8,2 @@\n-SETTING_8 = 56\n+SETTING_8 = 57\n SETTING_9 = 63'),
  ];
  const seen = seenLines(jsonl(rows), TARGET);
  for (const key of ['SETTING_1 = 7', 'SETTING_2 = 14', 'SETTING_20 = 140', 'SETTING_3 = 21', 'SETTING_8 = 56', 'SETTING_8 = 57', 'SETTING_9 = 63']) {
    assert.ok(seen.has(key), key);
  }
  assert.ok(!seen.has('SETTING_30 = 210'));
});

test('counts text Claude wrote into the file through the shell', () => {
  const heredoc = toolUse('Bash', { command: "cat > settings.py <<'EOF'\nfrom_shell = 1\nEOF" });
  assert.ok(seenLines(jsonl([heredoc.row]), TARGET).has('from_shell = 1'));
});

test('forgets what came before a compaction, except the segment it kept and the files it attached', () => {
  const early = readRows(TARGET, LINES, 1, 10);
  const keptUse = toolUse('Read', { file_path: TARGET, offset: 11, limit: 2 });
  const keptRows = [keptUse.row, toolResult(keptUse.id, '11\tSETTING_11 = 77\n12\tSETTING_12 = 84')];
  const between = readRows(TARGET, LINES, 13, 2);
  const boundary = {
    type: 'system', subtype: 'compact_boundary', uuid: uuid(), parentUuid: null,
    compactMetadata: { trigger: 'auto', preservedSegment: { headUuid: keptRows[0].uuid, anchorUuid: 'x', tailUuid: keptRows[1].uuid } },
  };
  const attached = {
    type: 'attachment', uuid: uuid(),
    attachment: { type: 'file', filename: TARGET, content: { type: 'text', file: { filePath: TARGET, content: 'SETTING_20 = 140\nSETTING_21 = 147' } } },
  };
  const edited = { type: 'attachment', uuid: uuid(), attachment: { type: 'edited_text_file', filename: TARGET, snippet: '25\tSETTING_25 = 175' } };
  const after = readRows(TARGET, LINES, 30, 1);
  const seen = seenLines(jsonl([...early, ...keptRows, ...between, boundary, attached, edited, ...after]), TARGET);
  assert.ok(!seen.has('SETTING_1 = 7'), 'read before the boundary');
  assert.ok(!seen.has('SETTING_13 = 91'), 'read before the boundary, outside the kept segment');
  for (const key of ['SETTING_11 = 77', 'SETTING_12 = 84', 'SETTING_20 = 140', 'SETTING_21 = 147', 'SETTING_25 = 175', 'SETTING_30 = 210']) {
    assert.ok(seen.has(key), key);
  }
});

test('ignores subagent rows in the main transcript', () => {
  const rows = readRows(TARGET, LINES, 1, 3);
  for (const r of rows) r.isSidechain = true;
  assert.equal(seenLines(jsonl(rows), TARGET).size, 0);
});

test('survives malformed rows', () => {
  const text = '{"type":"user", settings.py broken\n' + jsonl(readRows(TARGET, LINES, 1, 1)) + 'not json settings.py\n';
  assert.ok(seenLines(text, TARGET).has('SETTING_1 = 7'));
});

test('matches paths the way the file system does', () => {
  const mixed = TARGET.toUpperCase();
  const insensitive = process.platform === 'win32' || process.platform === 'darwin';
  assert.equal(normalizePath(mixed) === normalizePath(TARGET), insensitive);
  if (process.platform === 'win32') assert.equal(normalizePath(TARGET.replace(/\\/g, '/')), normalizePath(TARGET));
});

test('finds the transcript, or a subagent\'s own one', () => {
  const main = path.join(root, 'sess.jsonl');
  fs.writeFileSync(main, '');
  assert.equal(transcriptFor({ transcript_path: main }), main);
  assert.equal(transcriptFor({ transcript_path: main, agent_id: 'abc' }), null);
  const own = path.join(root, 'sess', 'subagents', 'agent-abc.jsonl');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, '');
  assert.equal(transcriptFor({ transcript_path: main, agent_id: 'abc' }), own);
  assert.equal(transcriptFor({ transcript_path: path.join(root, 'missing.jsonl') }), null);
  assert.equal(transcriptFor({}), null);
});

test('reads a transcript file', () => {
  const file = path.join(root, 'read.jsonl');
  fs.writeFileSync(file, jsonl(readRows(TARGET, LINES, 1, 1)));
  assert.ok(seenLines(readTranscript(file), TARGET).has('SETTING_1 = 7'));
  assert.equal(readTranscript(path.join(root, 'nope.jsonl')), null);
});
