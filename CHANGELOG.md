# Changelog

## 1.0.0 - 2026-10-07

- PreToolUse hook on Write that checks what a Write would delete from the file it replaces.
- Blocks a Write that would delete 10 or more lines (and at least 5% of the file) that Claude never
  saw in the conversation, and names the unread line ranges. What Claude saw comes from the session
  transcript: Read results, earlier Writes and Edits, attached files, and shell or search output
  that named the file, counting only what is still in context after a compaction.
- Blocks a Write whose new content adds a placeholder comment such as `// ... existing code ...`
  while deleting real lines.
- Asks before a Write that would keep less than 10% of a file of 30 or more lines.
- Skips new files, files under 20 non-blank lines, binary files and notebooks, and lets the Write
  through if anything goes wrong inside the hook.
