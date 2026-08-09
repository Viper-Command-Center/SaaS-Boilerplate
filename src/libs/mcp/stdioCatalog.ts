/**
 * Allowlist of stdio MCP servers this platform can spawn.
 *
 * 🔴 THIS FILE IS THE SECURITY BOUNDARY for the stdio transport.
 * A stdio connection stores only a KEY into this table (in
 * pluginCatalog.provider). The executable is resolved here, from packages
 * pinned in OUR package.json — never from user input. Adding a server to
 * Artivio = add the npm dependency + one entry here. Nothing a workspace
 * owner types can ever become a spawned command.
 *
 * Env is built per-connection from two safe inputs:
 *   target      — the connection's url field (e.g. the client's site URL)
 *   credential  — the single vault-sealed secret the workspace pasted
 * buildEnv decides how those map onto the server's environment variables.
 */

import { createRequire } from 'node:module';

export type StdioServerSpec = {
  /** Allowlist key. Stored in pluginCatalog.provider for stdio entries. */
  key: string;
  name: string;
  /**
   * All current stdio servers are per-connection (each workspace brings its
   * own target + credential, like the WordPress built-in). A future platform-
   * credential stdio server would add tier-1 handling in the plugins route.
   */
  perConnection: true;
  /** Shown next to the credential field when enabling. */
  credentialLabel: string;
  /** Shown next to the site/target field when enabling. */
  targetLabel: string;
  /**
   * Resolve the absolute path of the server's entry script. Throws if the
   * package isn't installed — surfaced as a failedConnection, never a crash.
   */
  resolveEntry: () => string;
  /** Map (target, decrypted credential) → the child process env. */
  buildEnv: (target: string, credential: string) => Record<string, string>;
};

// Resolve from the APP's node_modules at runtime (not from whatever module
// graph the bundler built) — Next.js never needs to know these packages exist.
const appRequire = createRequire(`${process.cwd()}/package.json`);

export const STDIO_SERVERS: Record<string, StdioServerSpec> = {
  diviops: {
    key: 'diviops',
    name: 'DiviOps (Divi 5 website authoring)',
    perConnection: true,
    credentialLabel:
      'username:application password for the WordPress site (WP Admin → Users → Profile → Application Passwords). Same format as the WordPress plugin.',
    targetLabel: 'The WordPress site URL, e.g. https://clientsite.com',
    resolveEntry: () => {
      try {
        // bin "diviops-mcp" → dist/index.js (verified against @diviops/mcp-server 1.5.38)
        return appRequire.resolve('@diviops/mcp-server/dist/index.js');
      } catch {
        throw new Error(
          '@diviops/mcp-server is not installed. Add it to package.json dependencies and redeploy.',
        );
      }
    },
    buildEnv: (target, credential) => {
      const url = target.trim().replace(/\/$/, '');
      // Credential convention matches the WordPress built-in: "user:app password".
      // App passwords may contain spaces but never a colon, so split at the FIRST colon.
      const idx = credential.indexOf(':');
      if (!url || idx <= 0) {
        throw new Error(
          'DiviOps needs the site URL and a credential in the form username:application-password.',
        );
      }
      return {
        WP_URL: url,
        WP_USER: credential.slice(0, idx).trim(),
        WP_APP_PASSWORD: credential.slice(idx + 1).trim(),
      };
    },
  },
};

export function getStdioServer(key: string | null | undefined): StdioServerSpec | undefined {
  return key ? STDIO_SERVERS[key] : undefined;
}

/** For the admin UI: what stdio servers can be added to the catalog. */
export function listStdioServers() {
  return Object.values(STDIO_SERVERS).map(s => ({
    key: s.key,
    name: s.name,
    perConnection: s.perConnection,
    credentialLabel: s.credentialLabel,
    targetLabel: s.targetLabel,
  }));
}
