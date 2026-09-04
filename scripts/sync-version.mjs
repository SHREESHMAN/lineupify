// Copies package.json's version into manifest.json (Claude Desktop bundle) and
// server.json (MCP Registry). Runs automatically from the `version` npm script,
// i.e. on `npm version patch|minor|major`; can also be run by hand.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = async (f) => JSON.parse(await fs.readFile(path.join(root, f), 'utf8'));
const write = (f, obj) => fs.writeFile(path.join(root, f), JSON.stringify(obj, null, 2) + '\n');

const { version } = await read('package.json');
const manifest = await read('manifest.json');
manifest.version = version;
await write('manifest.json', manifest);

const server = await read('server.json');
server.version = version;
for (const p of server.packages ?? []) p.version = version;
await write('server.json', server);

console.log(`manifest.json and server.json set to ${version}`);
