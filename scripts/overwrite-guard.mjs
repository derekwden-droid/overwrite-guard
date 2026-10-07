#!/usr/bin/env node
// overwrite-guard's hook entry point. The plugin's hooks.json runs it before every Write
// (PreToolUse). It reads the hook input as JSON on standard input and prints a JSON reply only
// when the Write would delete lines Claude never read, replace them with a placeholder, or
// replace nearly all of the file. Any error exits with status 1, which Claude Code reports
// without blocking the Write.

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  if (!/"tool_name"\s*:\s*"Write"/.test(raw)) return;
  const { handleWrite } = await import('./lib/hook.mjs');
  const reply = await handleWrite(JSON.parse(raw));
  if (reply) process.stdout.write(JSON.stringify(reply));
}

main().catch((err) => {
  process.stderr.write('overwrite-guard: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exitCode = 1;
});
