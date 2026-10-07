// Builds transcript rows shaped like Claude Code's session JSONL, for the tests.

let n = 0;

export function uuid() {
  n += 1;
  return '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
}

export function toolUse(name, input, id = 'toolu_' + uuid().slice(-6)) {
  return { row: { type: 'assistant', uuid: uuid(), isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }, id };
}

export function toolResult(id, content, extra = {}) {
  return { type: 'user', uuid: uuid(), isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra };
}

// A Read of `lines` (1-based start) as Claude Code records it: numbered text in the tool result
// and the raw text in toolUseResult.
export function readRows(file, all, start = 1, count = all.length, structured = true) {
  const slice = all.slice(start - 1, start - 1 + count);
  const use = toolUse('Read', count === all.length ? { file_path: file } : { file_path: file, offset: start, limit: count });
  const numbered = slice.map((l, i) => String(start + i) + '\t' + l).join('\n');
  const extra = structured ? { toolUseResult: { type: 'text', file: { filePath: file, content: slice.join('\n'), numLines: slice.length, startLine: start, totalLines: all.length } } } : {};
  return [use.row, toolResult(use.id, numbered, extra)];
}

export function jsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
