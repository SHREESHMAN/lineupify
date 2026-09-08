/** The package version, read from package.json so every module (User-Agent, status, CLI) reports the same one. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const VERSION: string = (require('../../package.json') as { version: string }).version;
