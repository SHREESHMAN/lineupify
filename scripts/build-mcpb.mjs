// Build lineupify.mcpb for Claude Desktop: stage dist + manifest + prod deps, then pack.
// Usage: npm run bundle:mcpb   (needs `npm run build` first; runs it if dist is missing)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, 'build', 'mcpb');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

if (!(await fs.stat(path.join(root, 'dist', 'index.js')).catch(() => null))) run('npm', ['run', 'build'], root);

await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });
await fs.cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true, filter: (p) => !p.endsWith('.map') });
await fs.cp(path.join(root, 'docs'), path.join(stage, 'docs'), { recursive: true });
for (const f of ['README.md', 'LICENSE']) await fs.copyFile(path.join(root, f), path.join(stage, f));

manifest.version = pkg.version;
await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
await fs.writeFile(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', dependencies: pkg.dependencies, overrides: pkg.overrides }, null, 2),
);

run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], stage);
await fs.rm(path.join(stage, 'package-lock.json'), { force: true });

const out = path.join(root, 'build', `lineupify-${pkg.version}.mcpb`);
run('npx', ['-y', '@anthropic-ai/mcpb', 'pack', stage, out], root);
const size = (await fs.stat(out)).size;
console.log(`\nWrote ${out} (${(size / 1024 / 1024).toFixed(1)} MB)`);
