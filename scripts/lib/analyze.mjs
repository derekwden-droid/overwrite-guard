// What a Write would do to the file it replaces: which lines it deletes, whether its new
// content holds a placeholder such as "// ... existing code ...", and how much of the old
// file survives. Lines are compared by their text with surrounding whitespace trimmed, so
// lines that only moved or were re-indented don't count as deleted.

const ELLIPSIS = String.fromCharCode(0x2026);

// Lines that carry no content of their own: closing brackets, separators, block keywords.
const TRIVIAL_WORDS = new Set(['end', 'fi', 'done', 'esac', 'else', 'endif', 'endfor', 'endwhile', 'begin', 'then', 'do', 'try', 'finally', 'pass']);

export function lineKey(line) {
  return line.trim();
}

export function isTrivial(key) {
  if (key === '') return true;
  if (key.length <= 4 && !/[A-Za-z0-9]/.test(key)) return true;
  return TRIVIAL_WORDS.has(key.replace(/[;:,]+$/, '').toLowerCase());
}

// Counts each distinct key in a list of lines.
export function countKeys(lines, skipTrivial) {
  const counts = new Map();
  for (const line of lines) {
    const key = lineKey(line);
    if (skipTrivial && isTrivial(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// A comment on a line by itself, split into its marker and its text. In Markdown a "#" starts a
// heading, so only HTML and MDX comments count there.
const COMMENT = /^(\/\/+|#+|\/\*+|\{\/\*+|<!--|--|;+|%+)(.*)$/;
const MARKDOWN_COMMENT = /^(<!--|\{\/\*+)(.*)$/;
const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const COMMENT_END = /(\*+\/\}?|-->)\s*$/;

function commentBody(key, ext) {
  const m = (MARKDOWN.has(ext) ? MARKDOWN_COMMENT : COMMENT).exec(key);
  if (!m) return null;
  return m[2].replace(COMMENT_END, '').trim();
}

// Words that, next to "...", say the comment stands in for code.
const NEAR_DOTS = /\b(existing|rest|remain\w*|previous\w*|other|more|same|here|before|original|unchanged|omitted|code|lines?|etc)\b/i;
// What a placeholder stands in for.
const NOUN = '(code|file|class|module|function|functions|component|components|settings|config|configuration|content|contents|document|implementation|lines?|methods|page|template|styles|imports|script|section|sections|body|tests|handlers|helpers|logic|properties|fields|keys|options|entries|markup|jsx|html|css|rules|rest|everything|remainder|above|below)';
const HAS_NOUN = new RegExp('\\b' + NOUN + '\\b', 'i');
const BREVITY = /\bfor brevity\b/i;
const REST_OF = new RegExp('\\b(rest|remainder) of (the |this |your )?' + NOUN + '\\b', 'i');
const EXISTING = new RegExp('^(keep |the |your )?(existing|previous|original) ' + NOUN + '\\b', 'i');
const KEEP_REST = /\b(keep|leave) (the rest|everything else)\b|\beverything else (is |stays |remains )?(unchanged|the same|as is)\b/i;
const OMITTED = /\b(omitted|elided|not shown|truncated)\b/i;
const GOES_HERE = /\b(code|implementation|logic|rest|everything|content|body|methods|functions|lines)\b.*\bgoe?s? here\b/i;
const SAME = /\b(unchanged|(remains?|stays?|is|are) (the same|unchanged)|same as (before|above|original|previous)|as before|as is)\b/i;
const SAME_ALL = new RegExp(SAME.source, 'gi');

// True when a line is a comment that stands in for code left out: "// ... existing code ...",
// "# rest of the settings unchanged", "<!-- ... -->". A bare "..." isn't one: it is real code
// in Python stubs and JavaScript spreads, so the line has to be a comment. Ordinary comments
// that merely use these words ("# Other settings", "# API key goes here") don't count.
export function isPlaceholder(line, ext = '') {
  const body = commentBody(lineKey(line), ext);
  if (body === null) return false;
  const text = body.replace(/^[[(]\s*/, '').replace(/\s*[\])]$/, '').trim();
  if (text === '') return false;
  const hasDots = text.includes('...') || text.includes(ELLIPSIS);
  const words = text.replace(/\.{3,}/g, ' ').split(ELLIPSIS).join(' ').replace(/^[\s:;,-]+|[\s:;,-]+$/g, '');
  if (hasDots && words === '') return true;
  if (hasDots && NEAR_DOTS.test(words)) return true;
  const count = words.split(/\s+/).length;
  if (count > 12) return false;
  if (BREVITY.test(words) || REST_OF.test(words) || EXISTING.test(words) || KEEP_REST.test(words) || GOES_HERE.test(words)) return true;
  if (OMITTED.test(words) && (count <= 3 || HAS_NOUN.test(words.replace(OMITTED, ' ')))) return true;
  if (SAME.test(words)) {
    const rest = words.replace(SAME_ALL, ' ').trim();
    return rest === '' || HAS_NOUN.test(rest);
  }
  return false;
}

// Compares the file's current lines with the lines a Write would leave. `ext` is the file's
// extension, which decides what counts as a comment.
export function compare(oldLines, newLines, ext = '') {
  const oldCounts = countKeys(oldLines, true);
  const newCounts = countKeys(newLines, false);
  const removed = new Map();
  let removedTotal = 0;
  let oldTotal = 0;
  let survived = 0;
  for (const [key, count] of oldCounts) {
    oldTotal += count;
    const kept = Math.min(count, newCounts.get(key) || 0);
    survived += kept;
    if (count > kept) {
      removed.set(key, count - kept);
      removedTotal += count - kept;
    }
  }
  const placeholders = [];
  newLines.forEach((line, i) => {
    if (!oldCounts.has(lineKey(line)) && isPlaceholder(line, ext)) placeholders.push({ line: i + 1, text: lineKey(line) });
  });
  return { oldTotal, removed, removedTotal, survived, placeholders };
}

// Sums the deleted lines whose text Claude never saw.
export function unseenRemoved(removed, seen) {
  let total = 0;
  for (const [key, count] of removed) if (!seen.has(key)) total += count;
  return total;
}

// The 1-based line ranges of the old file that hold deleted lines matching a test. Trivial lines
// between two matching lines join their ranges.
export function lineRanges(oldLines, removed, test) {
  const ranges = [];
  let start = 0;
  let end = 0;
  oldLines.forEach((line, i) => {
    const key = lineKey(line);
    if (isTrivial(key)) return;
    if (removed.has(key) && test(key)) {
      if (!start) start = i + 1;
      end = i + 1;
      return;
    }
    if (start) ranges.push([start, end]);
    start = end = 0;
  });
  if (start) ranges.push([start, end]);
  return ranges;
}

export function formatRanges(ranges, max = 5) {
  const parts = ranges.slice(0, max).map(([a, b]) => (a === b ? String(a) : a + '-' + b));
  let text = (ranges.length === 1 && ranges[0][0] === ranges[0][1] ? 'line ' : 'lines ') + parts.join(', ');
  if (ranges.length > max) text += ' and ' + (ranges.length - max) + ' more ' + (ranges.length - max === 1 ? 'range' : 'ranges');
  return text;
}
