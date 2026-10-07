// Reading a file as text: UTF-8 or UTF-16, with any byte-order mark removed. Shared with the
// edit-doctor plugin.

import fs from 'node:fs';

export const MAX_BYTES = 8 * 1024 * 1024;

// ignoreBOM keeps a U+FEFF at the start in the text, so a second byte-order mark after the
// first one isn't silently swallowed.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeUtf16(bytes, bigEndian) {
  if (bytes.length % 2 !== 0) return null;
  const copy = Buffer.from(bytes);
  if (bigEndian) copy.swap16();
  return copy.toString('utf16le');
}

// Returns the text of a buffer, or null when it isn't UTF-8 or UTF-16 text.
export function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    try {
      return utf8.decode(buf.subarray(3));
    } catch {
      return null;
    }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    if (buf.length >= 4 && buf[2] === 0 && buf[3] === 0) return null;
    return decodeUtf16(buf.subarray(2), false);
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return decodeUtf16(buf.subarray(2), true);
  try {
    return utf8.decode(buf);
  } catch {
    return null;
  }
}

// Reads a file as text. Returns null for a missing, unreadable, oversized or binary file.
export function readText(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return decode(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

// Splits text into lines on LF, CRLF or a lone CR. A final line break doesn't start a line.
export function splitLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
