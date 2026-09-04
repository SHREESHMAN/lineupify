// Dependency-free stdio MCP client used to smoke-test the built server:
//   node test/smoke/mcp-stdio.mjs [toolName] [jsonArgs]
// Default: lists tools, calls status and parse_lineup.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const child = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LINEUPIFY_LOG: process.env.LINEUPIFY_LOG ?? 'error' } });

let buf = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('non-json on stdout:', line);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(method, params, notify = false) {
  const msg = { jsonrpc: '2.0', method, params };
  if (!notify) msg.id = nextId++;
  child.stdin.write(JSON.stringify(msg) + '\n');
  if (notify) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60_000);
    pending.set(msg.id, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function show(res) {
  if (res.error) return console.log('ERROR', JSON.stringify(res.error));
  const r = res.result;
  if (r?.content) {
    for (const c of r.content) console.log(c.type === 'text' ? c.text : `[${c.type}]`);
    if (r.isError) console.log('(isError)');
  } else console.log(JSON.stringify(r, null, 2).slice(0, 4000));
}

const [tool, argsJson] = process.argv.slice(2);
try {
  const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.0' } });
  console.log('initialized:', init.result?.serverInfo?.name, init.result?.serverInfo?.version, 'protocol', init.result?.protocolVersion);
  await send('notifications/initialized', {}, true);
  if (tool) {
    show(await send('tools/call', { name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} }));
  } else {
    const list = await send('tools/list', {});
    console.log('tools:', list.result?.tools?.map((t) => `${t.name}${t.annotations?.readOnlyHint ? ' (ro)' : ''}`).join(', '));
    console.log('\n--- status ---');
    show(await send('tools/call', { name: 'status', arguments: {} }));
    console.log('\n--- parse_lineup ---');
    show(
      await send('tools/call', {
        name: 'parse_lineup',
        arguments: { text: 'FRIDAY 26 JUNE\nFRED AGAIN.. • THE 1975\nWET LEG (DJ SET) • KNEECAP • FONTAINES D.C.\nTYLER, THE CREATOR | A$AP ROCKY | CHARLI XCX | SKRILLEX B2B FOUR TET\nTICKETS ON SALE NOW\nwww.example.com' },
      }),
    );
  }
} catch (err) {
  console.error(String(err));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    const killer = setTimeout(() => {
      child.kill();
      resolve();
    }, 8000);
    child.once('exit', () => {
      clearTimeout(killer);
      resolve();
    });
  });
}
