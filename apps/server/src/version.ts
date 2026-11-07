import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string; name: string };

export const SERVER_VERSION: string = pkg.version;
export const SERVER_NAME_PKG: string = pkg.name;
