# overwrite-guard plugin privacy policy

Last updated: October 7, 2026

The overwrite-guard plugin for Claude Code collects no data. It has no servers, no accounts, no
analytics and no telemetry, and it never connects to the network.

## What the plugin accesses

Before each Write, Claude Code passes the plugin the path and new content of the file Claude is
about to write, plus the path of this session's transcript. The plugin reads the file being
replaced from your computer. When the Write would delete 10 or more of its lines, the plugin also
reads the session transcript, which Claude Code keeps on your computer, to find what Claude has
already seen of that file. It reads no other files.

## What happens to that data

The plugin compares the old and new text and either says nothing or returns a short message:
to Claude when it blocks a Write, or to you in the permission prompt when it asks first. The
message can name the file, count lines, list line numbers and quote one line of the new content.
It writes nothing to disk and keeps no logs, caches or copies.

Its messages become part of your conversation with Claude, like any other hook output. How
Anthropic handles your conversations is covered by Anthropic's own privacy policy, not this one.

## Retention

None. Nothing outlives the hook call that read it.

## Changes and contact

Changes to this policy are made in this file and recorded in the repository's history. Questions
go to [github.com/derekwden-droid/overwrite-guard/issues](https://github.com/derekwden-droid/overwrite-guard/issues).
