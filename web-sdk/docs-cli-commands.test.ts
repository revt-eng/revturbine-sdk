/**
 * Plan 195 item 6 — the docs may only name CLI commands that exist.
 *
 * `guides/coding-agent.mdx` taught `revturbine verify` and `revturbine deploy`.
 * Neither is a registered command — the real verbs are `validate` and `launch`.
 * It also passed a file to `preview` (which takes no argument) and used
 * `evaluate --handle` (the flag is `--entitlement`).
 *
 * That page is, by its own title, **the one most likely to be read by an
 * agent**, which will run what it is told and get "unknown command". The
 * docs-example harness cannot catch this: bash fences are not compilation
 * units, so nothing has ever checked a command name in this repo.
 *
 * Same two-directional shape as the entitlement reason-code test (plan 191
 * AC-6): the docs must name only real commands, AND the list they are checked
 * against must itself be real.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * Commands registered by `@revturbine/cli`.
 *
 * DECLARED, not derived: the CLI lives in its own repo and is not a dependency
 * here, so there is nothing to introspect at test time. That makes this list a
 * maintenance obligation, and the honest way to carry one is to say so and
 * make refreshing it a single command:
 *
 *   (cd <revturbine-cli> && git show origin/main:src/cli.ts \
 *      | grep -oE "\\.command\\('[a-z][a-z-]*'" | sed "s/.*'\\(.*\\)'/\\1/" | sort -u)
 *
 * Captured 2026-08-20 against revturbine-cli@origin/main.
 */
const CLI_COMMANDS = new Set([
  'create', 'diff', 'discard', 'docs', 'download', 'evaluate', 'generate',
  'history', 'ingest-keys', 'init', 'launch', 'list', 'login', 'logout',
  'preview', 'restore', 'revoke', 'schema', 'show', 'signup', 'status',
  'types', 'upload', 'validate', 'whoami',
]);

/** Named so they stay dead: taught in the docs, never registered. */
const NEVER_EXISTED = ['verify', 'deploy'];

const DOC_ROOTS = [
  join(ROOT, 'pages-build', 'src', 'content', 'docs'),
  join(ROOT, 'docs'),
];

function docFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) docFiles(full, out);
    else if (/\.mdx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * `revturbine <command>` occurrences, with the noise excluded.
 *
 * `--help`, `--version`, a bare `revturbine`, and the npm package name in an
 * install line are all legitimate and name no command.
 */
function invokedCommands(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    // `npx revturbine`, `pnpm revturbine`, and install lines are not invocations
    // of a subcommand we can validate.
    if (/\b(install|add|create)\s+revturbine/.test(line)) continue;
    // `from revturbine import RevTurbineCustomerSdk` is Python, and the PyPI
    // package shares the CLI's name. Caught as a false positive on its first
    // run — worth excluding rather than letting a real finding sit next to
    // noise nobody trusts.
    if (/^\s*(from|import)\s/.test(line)) continue;
    for (const m of line.matchAll(/(?:^|[\s`$(])revturbine\s+([a-z][a-z-]*)/g)) {
      found.add(m[1]);
    }
  }
  return [...found];
}

const FILES = DOC_ROOTS.flatMap((root) => docFiles(root));

describe('docs name only CLI commands that exist (plan 195 item 6)', () => {
  it('finds docs to scan — an empty sweep would pass vacuously', () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(FILES.some((f) => invokedCommands(readFileSync(f, 'utf8')).length > 0)).toBe(true);
  });

  it('every invoked command is registered', () => {
    const unknown: string[] = [];
    for (const file of FILES) {
      for (const command of invokedCommands(readFileSync(file, 'utf8'))) {
        if (!CLI_COMMANDS.has(command)) {
          unknown.push(`${relative(ROOT, file)} → revturbine ${command}`);
        }
      }
    }

    expect(
      unknown,
      'the docs invoke CLI command(s) that do not exist. An agent following ' +
        'these gets "unknown command". If the CLI gained a verb, refresh ' +
        'CLI_COMMANDS with the command in its doc comment.',
    ).toEqual([]);
  });

  it('the commands that never existed stay gone', () => {
    for (const dead of NEVER_EXISTED) {
      expect(CLI_COMMANDS.has(dead), `${dead} was never a command`).toBe(false);
    }
  });

  it('the declared list is not empty or absurd', () => {
    // Guards the failure mode where a bad refresh empties the list and every
    // assertion above starts passing for the wrong reason.
    expect(CLI_COMMANDS.size).toBeGreaterThan(10);
    expect(CLI_COMMANDS.has('validate')).toBe(true);
    expect(CLI_COMMANDS.has('launch')).toBe(true);
  });
});
