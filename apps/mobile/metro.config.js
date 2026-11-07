// Metro config for a pnpm (hoisted) monorepo: watch the workspace root so
// @mobile-ide/core (symlinked from packages/core) is bundled and hot-reloaded,
// and resolve packages from both the app's and the root node_modules.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// @mobile-ide/core is ESM with an "exports" map; shiki and friends also rely on it.
config.resolver.unstable_enablePackageExports = true;
// Prefer "browser"/"import" conditions for web-only DOM component deps, keep RN first.
config.resolver.unstable_conditionNames = ['react-native', 'browser', 'import', 'require', 'default'];

module.exports = config;
