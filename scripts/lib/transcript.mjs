// The text of a file that Claude has seen in this conversation, rebuilt from the session
// transcript (JSONL). It counts Read results, the content of earlier Writes and Edits to the
// file, files Claude Code attached to the conversation, and the output of shell and search
// commands that named the file. After a compaction only what is still in Claude's context
// counts: rows after the last compaction boundary, plus the segment it kept.

import fs from 'node:fs';
import path from 'node:path';
import { lineKey } from './analyze.mjs';

// Transcripts past this size are read from the end only. What's left out is older than
// anything still in a context window that size.
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

const ARROW = String.fromCharCode(0x2192);
// "     12<TAB>text" (Read) or "12<ARROW>text" (older Read output).
const READ_PREFIX = new RegExp('^\\s*\\d+(\\t|' + ARROW + ')');
// "12:text", "12-text" (grep -n and its context lines) or "12<TAB>text" (cat -n).
const SHELL_PREFIX = new RegExp('^\\s*\\d+[\\t:|' + ARROW + '-]');
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

export function normalizePath(p, cwd) {
  if (typeof p !== 'string' || p === '') return '';
  let full = cwd ? path.resolve(cwd, p) : path.resolve(p);
  if (process.platform === 'win32') full = full.replace(/\//g, '\\');
  return CASE_INSENSITIVE ? full.toLowerCase() : full;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addLines(seen, text, stripPrefix) {
  if (typeof text !== 'string' || text === '') return;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (stripPrefix) {
      if (!stripPrefix.test(line)) continue;
      seen.add(lineKey(line.replace(stripPrefix, '')));
    } else {
      seen.add(lineKey(line));
    }
  }
}

// Shell and search output: each line as printed, and without a line-number, file-name or
// diff prefix.
function addOutput(seen, text, nameRe) {
  if (typeof text !== 'string' || text === '') return;
  for (const line of text.split(/\r\n|\r|\n/)) {
    seen.add(lineKey(line));
    if (SHELL_PREFIX.test(line)) seen.add(lineKey(line.replace(SHELL_PREFIX, '')));
    if (/^[+-](?![+-]{2} )/.test(line)) seen.add(lineKey(line.slice(1)));
    const m = nameRe.exec(line);
    if (m) {
      const rest = line.slice(m.index + m[0].length);
      seen.add(lineKey(rest.replace(/^\d+[:-]/, '')));
    }
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

// Picks the rows of the transcript still in Claude's context.
function contextWindow(lines) {
  let boundary = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('"compact_boundary"')) {
      try {
        const row = JSON.parse(lines[i]);
        if (row && row.subtype === 'compact_boundary') {
          boundary = i;
          break;
        }
      } catch {
        // Not a boundary row after all.
      }
    }
  }
  if (boundary < 0) return () => true;
  let head = -1;
  let tail = -1;
  try {
    const kept = JSON.parse(lines[boundary]).compactMetadata.preservedSegment;
    if (kept && kept.headUuid && kept.tailUuid) {
      const headTag = '"uuid":"' + kept.headUuid + '"';
      const tailTag = '"uuid":"' + kept.tailUuid + '"';
      for (let i = 0; i < boundary; i++) {
        if (head < 0 && lines[i].includes(headTag)) head = i;
        if (lines[i].includes(tailTag)) tail = i;
      }
    }
  } catch {
    // No kept segment.
  }
  return (i) => i > boundary || (head >= 0 && tail >= head && i >= head && i <= tail);
}

// Reads the transcript, or its last MAX_TRANSCRIPT_BYTES. Returns null when it can't.
export function readTranscript(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    if (stat.size <= MAX_TRANSCRIPT_BYTES) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
      fs.readSync(fd, buf, 0, MAX_TRANSCRIPT_BYTES, stat.size - MAX_TRANSCRIPT_BYTES);
      const text = buf.toString('utf8');
      return text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// The set of trimmed line texts of `target` that Claude has seen in the transcript text.
// `skipId` is the tool_use_id of the Write being checked.
export function seenLines(transcriptText, target, options = {}) {
  const cwd = options.cwd;
  const want = normalizePath(target, cwd);
  const base = path.basename(target);
  const nameRe = new RegExp(escapeRegExp(base), CASE_INSENSITIVE ? 'i' : '');
  const outputNameRe = new RegExp(escapeRegExp(base) + '[:-]', CASE_INSENSITIVE ? 'i' : '');
  const seen = new Set();
  const pending = new Map();
  const lines = transcriptText.split('\n');
  const inWindow = contextWindow(lines);
  const same = (p) => normalizePath(p, cwd) === want;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === '' || !inWindow(i)) continue;
    let ids = null;
    if (pending.size > 0 && raw.includes('"tool_use_id"')) {
      ids = [...raw.matchAll(/"tool_use_id":"([^"]+)"/g)].map((m) => m[1]).filter((id) => pending.has(id));
    }
    if (!nameRe.test(raw) && !(ids && ids.length)) continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object' || row.isSidechain === true) continue;

    const att = row.attachment;
    if (att && typeof att === 'object') {
      const file = att.content && att.content.file;
      if (att.type === 'file' && file && same(file.filePath)) addLines(seen, file.content, null);
      if (att.type === 'edited_text_file' && same(att.filename)) addLines(seen, att.snippet, READ_PREFIX);
      continue;
    }

    const content = row.message && Array.isArray(row.message.content) ? row.message.content : [];
    if (row.type === 'assistant') {
      for (const block of content) {
        if (!block || block.type !== 'tool_use' || block.id === options.skipId) continue;
        const input = block.input && typeof block.input === 'object' ? block.input : {};
        if (FILE_TOOLS.has(block.name)) {
          if (!same(input.file_path)) continue;
          if (block.name === 'Read') pending.set(block.id, 'read');
          if (block.name === 'Write') addLines(seen, input.content, null);
          if (block.name === 'Edit') {
            addLines(seen, input.old_string, null);
            addLines(seen, input.new_string, null);
          }
          if (block.name === 'MultiEdit' && Array.isArray(input.edits)) {
            for (const e of input.edits) {
              if (!e) continue;
              addLines(seen, e.old_string, null);
              addLines(seen, e.new_string, null);
            }
          }
          continue;
        }
        const json = JSON.stringify(input);
        if (!nameRe.test(json)) continue;
        pending.set(block.id, 'output');
        if (typeof input.command === 'string') addLines(seen, input.command, null);
      }
      continue;
    }

    if (row.type !== 'user') continue;
    const results = content.filter((b) => b && b.type === 'tool_result');
    for (const block of results) {
      const kind = pending.get(block.tool_use_id);
      const text = resultText(block.content);
      if (kind === 'read') {
        const file = results.length === 1 && row.toolUseResult && row.toolUseResult.file;
        if (file && typeof file.content === 'string' && same(file.filePath)) addLines(seen, file.content, null);
        else addLines(seen, text, READ_PREFIX);
      } else if (kind === 'output') {
        addOutput(seen, text, outputNameRe);
      } else if (nameRe.test(text)) {
        // A search that didn't name the file but printed its lines, as "path:12:text".
        for (const line of text.split(/\r\n|\r|\n/)) {
          const m = outputNameRe.exec(line);
          if (m) seen.add(lineKey(line.slice(m.index + m[0].length).replace(/^\d+[:-]/, '')));
        }
      }
      pending.delete(block.tool_use_id);
    }
  }
  return seen;
}

// Where the transcript of the conversation making this call lives. A subagent has its own,
// in a "subagents" folder beside the main one. Returns null when it can't be found.
export function transcriptFor(input) {
  const main = input && typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (!main) return null;
  if (input.agent_id) {
    const dir = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents');
    const own = path.join(dir, 'agent-' + input.agent_id + '.jsonl');
    return fs.existsSync(own) ? own : null;
  }
  return fs.existsSync(main) ? main : null;
}
