// The PreToolUse check on Write. It looks at what the Write would delete from the file it
// replaces and blocks it when the deleted lines include many that Claude never saw in this
// conversation, or when the new content holds a placeholder such as "// ... existing code ..."
// where real lines used to be. It asks the user first when a Write would replace nearly all of
// a file. Otherwise it says nothing, and never approves a call on its own.

import fs from 'node:fs';
import path from 'node:path';
import { compare, formatRanges, lineKey, lineRanges, unseenRemoved } from './analyze.mjs';
import { readText, splitLines } from './text.mjs';
import { readTranscript, seenLines, transcriptFor } from './transcript.mjs';

export const MIN_LINES = 20;
export const MIN_UNSEEN = 10;
export const UNSEEN_SHARE = 0.05;
export const MIN_PLACEHOLDER_REMOVED = 3;
export const ASK_MIN_LINES = 30;
export const ASK_SURVIVAL = 0.1;
const SKIP_EXTENSIONS = new Set(['.ipynb']);
// The transcript is written a moment after each tool call, so a Read just before this Write
// may not be in it yet. Before blocking, wait this long and look again if it grew.
const SETTLE_MS = 300;

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many || one + 's');
}

function quote(text) {
  return '"' + (text.length > 80 ? text.slice(0, 77) + '...' : text) + '"';
}

function reply(decision, reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
}

// Everything about the Write that doesn't depend on the transcript.
export function assess(oldText, newText, ext = '') {
  const oldLines = splitLines(oldText);
  const nonBlank = oldLines.filter((l) => lineKey(l) !== '').length;
  if (nonBlank < MIN_LINES) return null;
  const newLines = splitLines(newText);
  const result = compare(oldLines, newLines, ext);
  result.oldLines = oldLines;
  result.unseenLimit = Math.max(MIN_UNSEEN, Math.ceil(result.oldTotal * UNSEEN_SHARE));
  return result;
}

// Decides on a Write from its assessment and the lines Claude has seen (null when unknown).
export function decide(a, seen, file) {
  if (!a) return null;
  const name = path.basename(file);
  const placeholder = a.placeholders.length > 0 && a.removedTotal >= MIN_PLACEHOLDER_REMOVED ? a.placeholders[0] : null;
  const unseen = seen ? unseenRemoved(a.removed, seen) : 0;
  const parts = [];

  if (seen && unseen >= a.unseenLimit) {
    const ranges = lineRanges(a.oldLines, a.removed, (k) => !seen.has(k));
    parts.push('overwrite-guard blocked this Write: it would delete ' + plural(unseen, 'line') + ' of ' + name +
      ' that you have not read in this conversation (' + formatRanges(ranges) + ' of ' + a.oldLines.length + ').' +
      ' Write replaces the whole file, so lines you have not seen are lost.');
    if (placeholder) {
      parts.push('Line ' + placeholder.line + ' of your new content, ' + quote(placeholder.text) +
        ', is a placeholder: it would be written into the file literally.');
    }
    parts.push('Read the rest of the file first (Read with offset and limit pages through a long one), then write the' +
      ' complete file, or use Edit to change only the part you mean to change.');
    return reply('deny', parts.join(' '));
  }

  if (placeholder) {
    const ranges = lineRanges(a.oldLines, a.removed, () => true);
    return reply('deny', 'overwrite-guard blocked this Write: line ' + placeholder.line + ' of your new content, ' +
      quote(placeholder.text) + ', is a placeholder for text that is in ' + name + ' now, and the Write would delete ' +
      plural(a.removedTotal, 'line') + ' (' + formatRanges(ranges) + '). Write replaces the whole file, so the placeholder' +
      ' would be written literally and those lines would be lost. Use Edit to change only the part you mean to change,' +
      ' or write the complete file with no placeholders.');
  }

  if (a.oldTotal >= ASK_MIN_LINES && a.survived < a.oldTotal * ASK_SURVIVAL) {
    return reply('ask', 'overwrite-guard: this Write replaces nearly all of ' + name + '. Only ' + a.survived + ' of its ' +
      a.oldTotal + ' lines with content would remain. Allow it only if the whole file is meant to be replaced.');
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function size(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

// PreToolUse. Returns the hook reply, or null to let the Write go ahead untouched.
export async function handleWrite(input, options = {}) {
  if (!input || input.tool_name !== 'Write') return null;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const file = toolInput.file_path;
  const content = toolInput.content;
  if (typeof file !== 'string' || file === '' || typeof content !== 'string') return null;
  if (SKIP_EXTENSIONS.has(path.extname(file).toLowerCase())) return null;
  const target = input.cwd ? path.resolve(input.cwd, file) : file;
  const oldText = readText(target);
  if (oldText === null) return null;
  const a = assess(oldText, content, path.extname(target).toLowerCase());
  if (!a) return null;

  let seen = null;
  if (a.removedTotal >= a.unseenLimit) {
    const transcript = transcriptFor(input);
    const look = () => {
      const text = transcript ? readTranscript(transcript) : null;
      return text === null ? null : seenLines(text, target, { cwd: input.cwd, skipId: input.tool_use_id });
    };
    seen = look();
    if (seen && unseenRemoved(a.removed, seen) >= a.unseenLimit) {
      const before = size(transcript);
      await sleep(options.settleMs ?? SETTLE_MS);
      if (size(transcript) !== before) seen = look();
    }
  }
  return decide(a, seen, target);
}
