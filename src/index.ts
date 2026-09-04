#!/usr/bin/env node
/**
 * Entry point. `lineupify-mcp` with no arguments serves MCP over stdio; the
 * other subcommands are setup helpers that run in a normal terminal.
 */
const major = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(major) || major < 20) {
  process.stderr.write(`lineupify-mcp needs Node.js 20 or newer (you have ${process.versions.node}). Install it from https://nodejs.org and try again.\n`);
  process.exit(1);
}

const [cmd = 'serve', ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  if (cmd === '--version' || cmd === '-v') {
    const { VERSION } = await import('./tools/connect.js');
    process.stdout.write(VERSION + '\n');
    return;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    const { help } = await import('./cli.js');
    process.stdout.write(help() + '\n');
    return;
  }
  if (cmd === 'serve') {
    const { serve } = await import('./server.js');
    await serve();
    return;
  }
  const { runCli } = await import('./cli.js');
  const code = await runCli(cmd, rest);
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`lineupify-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
