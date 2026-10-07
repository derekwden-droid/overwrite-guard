import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, formatRanges, isPlaceholder, isTrivial, lineRanges, unseenRemoved } from '../scripts/lib/analyze.mjs';

const ELLIPSIS = String.fromCharCode(0x2026);

test('treats brackets, separators and block keywords as trivial', () => {
  for (const line of ['', '}', '});', ']', '),', '---', '*/', 'end', 'fi', 'done;', 'else:', 'End']) {
    assert.equal(isTrivial(line), true, line);
  }
  for (const line of ['x = 1', 'return a', 'endpoint = "/v1"', 'a)', '} else {']) {
    assert.equal(isTrivial(line), false, line);
  }
});

test('recognises the placeholders models write in place of code', () => {
  const placeholders = [
    '# ... rest of the settings unchanged ...',
    '// ... existing code ...',
    '    // ...',
    '/* ... */',
    '<!-- ... rest of the page ... -->',
    '// Rest of the code remains the same',
    '# (unchanged)',
    '// other methods unchanged',
    '-- ... omitted for brevity',
    '{/* ... existing JSX ... */}',
    '// [previous code]',
    '; ... same as before',
    '// Existing code here',
    '# rest of file',
    '// helper functions unchanged',
    '# ' + ELLIPSIS,
    '// ' + ELLIPSIS + ' more handlers ' + ELLIPSIS,
    '// Lines 40-120 unchanged',
    '# keep the rest as is',
  ];
  for (const line of placeholders) assert.equal(isPlaceholder(line), true, line);
});

test('leaves ordinary comments and code alone', () => {
  const ordinary = [
    '# Loading...',
    '// Update existing user',
    '# return value unchanged if null',
    'x = [1, 2, ...]',
    '...',
    'def f(): ...',
    'const a = { ...b };',
    '# TODO',
    '//',
    '#',
    '// e.g. foo(a, b, ...)',
    '#!/usr/bin/env node',
    '## Rest API',
    '// Handles the rest of the request after auth',
    'print("... existing code ...")',
    '# Other settings',
    '# Old settings',
    '# Remaining options',
    '# Your API key goes here',
    '# port omitted means the default',
    '// Update existing settings for prod',
    '// keep this as is: the parser needs it',
  ];
  for (const line of ordinary) assert.equal(isPlaceholder(line), false, line);
});

test('in Markdown, treats # as a heading and only HTML comments as placeholders', () => {
  assert.equal(isPlaceholder('# Rest of the configuration', '.md'), false);
  assert.equal(isPlaceholder('## ... existing code ...', '.md'), false);
  assert.equal(isPlaceholder('<!-- ... rest of the page ... -->', '.md'), true);
  assert.equal(isPlaceholder('{/* ... existing JSX ... */}', '.mdx'), true);
  assert.equal(isPlaceholder('# ... existing code ...', '.py'), true);
});

test('counts deleted lines by text, ignoring moves, re-indents and trivial lines', () => {
  const oldLines = ['def f():', '    a = 1', '    b = 2', '', '}', 'def g():', '    return 3'];
  const newLines = ['def g():', '        return 3', 'def f():', '    a = 1'];
  const r = compare(oldLines, newLines);
  assert.equal(r.oldTotal, 5);
  assert.equal(r.removedTotal, 1);
  assert.deepEqual([...r.removed], [['b = 2', 1]]);
  assert.equal(r.survived, 4);
});

test('counts repeated lines as many times as they are deleted', () => {
  const r = compare(['x()', 'x()', 'x()', 'y()'], ['x()', 'y()']);
  assert.equal(r.removedTotal, 2);
  assert.equal(r.removed.get('x()'), 2);
});

test('reports only placeholders that are new to the file', () => {
  const oldLines = ['// ... existing code ...', 'a()', 'b()'];
  assert.deepEqual(compare(oldLines, ['// ... existing code ...', 'a()']).placeholders, []);
  assert.deepEqual(compare(['a()', 'b()'], ['a()', '# rest of file unchanged']).placeholders, [{ line: 2, text: '# rest of file unchanged' }]);
});

test('sums the deleted lines Claude never saw', () => {
  const removed = new Map([['a', 2], ['b', 3], ['c', 1]]);
  assert.equal(unseenRemoved(removed, new Set(['b'])), 3);
  assert.equal(unseenRemoved(removed, new Set()), 6);
});

test('reports unseen deletions as line ranges, bridging trivial lines', () => {
  const oldLines = ['seen1', 'u1', '}', '', 'u2', 'seen2', 'u3'];
  const removed = new Map([['u1', 1], ['u2', 1], ['u3', 1], ['seen1', 1]]);
  const ranges = lineRanges(oldLines, removed, (k) => !['seen1', 'seen2'].includes(k));
  assert.deepEqual(ranges, [[2, 5], [7, 7]]);
  assert.equal(formatRanges(ranges), 'lines 2-5, 7');
  assert.equal(formatRanges([[7, 7]]), 'line 7');
  assert.equal(formatRanges([[1, 1], [3, 3], [5, 5]], 2), 'lines 1, 3 and 1 more range');
});
