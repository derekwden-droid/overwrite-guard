# overwrite-guard

Claude Code's Write tool replaces a whole file. When Claude has read only part of that file, or writes `# ... rest of the settings unchanged ...` where the old code used to be, Write still answers "updated successfully" and the rest of the file is gone. A Read with `limit: 20` on a 300-line file shows no sign that 280 lines were left out, so Claude has no idea anything is missing. Reproduced on Claude Code 2.1.281: 295 of 300 lines lost in one call. Anthropic's tracker has the same story several times over (claude-code issues 78273, 98967, 27137, 14964 and 92979).

overwrite-guard checks every Write over an existing file before it happens:

- **Lines Claude never read.** It works out which lines the Write would delete and which of them Claude has seen in this conversation: in Read results, in its own earlier Writes and Edits, in files Claude Code attached, and in shell or search output that named the file. When 10 or more deleted lines (and at least 5% of the file) were never seen, it blocks the Write and tells Claude which line ranges it hasn't read.
- **Placeholders.** When the new content adds a comment such as `// ... existing code ...`, `# rest of the file unchanged` or `<!-- ... -->` while the Write deletes real lines, it blocks the Write even if Claude read everything, because the placeholder would be written into the file literally.
- **Near-total rewrites.** When a Write would keep less than 10% of a file of 30 or more lines and nothing above applies, it asks you before letting the Write go ahead. Deliberate rewrites are fine; this catches the ones that weren't.

Lines are compared by their text, so moving or re-indenting code doesn't count as deleting it, and blank lines and lone brackets are ignored. After the conversation is compacted, only what is still in Claude's context counts.

Here is what Claude saw in a real session, after reading the first 20 lines of a 300-line `settings.py` and trying to save it with a placeholder:

```
overwrite-guard blocked this Write: it would delete 280 lines of settings.py that you have not read in this conversation (lines 21-300 of 300). Write replaces the whole file, so lines you have not seen are lost. Line 4 of your new content, "# ... rest of the settings unchanged ...", is a placeholder: it would be written into the file literally. Read the rest of the file first (Read with offset and limit pages through a long one), then write the complete file, or use Edit to change only the part you mean to change.
```

The file kept all 300 lines. Claude then read the rest of it, and the same Write was blocked again, this time for the placeholder alone. A Write that dropped 150 lines Claude had now read went through without a word.

## Try it

1. "Use a shell command to create `settings.py` with 300 lines, `OPTION_1 = 1` through `OPTION_300 = 300`. Read only its first 20 lines, then use the Write tool to save it with `OPTION_2 = 5`."
2. "Read all of `settings.py`, then use Write to save it with `OPTION_3 = 9` and a `# ... rest unchanged ...` comment in place of everything after it."
3. "Use Write to replace `settings.py` with a three-line file." (overwrite-guard asks you first.)

## What's included

- **One hook.** PreToolUse on Write, which runs `node scripts/overwrite-guard.mjs` from this plugin before each Write. It says nothing unless the Write would delete unread lines, write a placeholder over real lines, or replace nearly all of a file.

Edit isn't checked: it replaces exact text Claude quotes, so it can't drop lines Claude hasn't seen.

## What it reads, runs and sends

- **Reads** the file a Write is about to replace, up to 8 MB. When the Write would delete 10 or more lines, it also reads this session's transcript file (the last 64 MB at most), which Claude Code passes to every hook, to find what Claude has seen of that file.
- **Writes** nothing, and keeps no logs or state.
- **Runs** `node scripts/overwrite-guard.mjs` before each Write. For a new file or a small change it exits after reading the file. Reading a 16 MB transcript takes about 125 ms.
- **Sends** nothing over the network. There is no telemetry and no account. See [PRIVACY.md](PRIVACY.md).

Its messages go into your conversation with Claude, like any other hook output.

## Limits

- It never approves a Write or changes one. It blocks, asks, or stays silent, and Claude decides how to recover.
- Files under 20 non-blank lines, binary files and notebooks are skipped.
- The transcript is written a moment after each tool call. If the Read just before a Write isn't in it yet, overwrite-guard waits 300 ms before blocking and looks again if the transcript grew.
- Placeholder detection looks for comments on a line of their own. A bare `...` is real code in Python and JavaScript, so it doesn't count.
- If anything goes wrong inside the hook, it lets the Write through, and Claude Code shows a hook error notice.
- If a file does get clobbered anyway, `/rewind` restores Claude Code's checkpoint from before the change.

## Requirements

- A Claude Code version with exec-form hooks (`"command"` plus `"args"`). Verified on 2.1.281 on Windows 11.
- Node.js 20 or later on your `PATH`.

## Development

`node --test` runs the tests. They need nothing beyond Node.

## License

MIT. See [LICENSE](LICENSE).
