/**
 * BUG-711 — every public name `server-node` exports from its own modules
 * (`./client`: `RevTurbineServer` and the errors its methods throw; `./types`:
 * every method's input and result type) is re-exported by the headless entry,
 * and so by the React root, which re-exports headless.
 *
 * 0.11.22 re-exported only the older type list: `CreateClientSessionInput`
 * and friends were TS2459 for customers. This walks the class, so a new
 * server type that is not re-exported fails here, not in a customer build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function exportedNames(file: string, fromModules?: ReadonlySet<string>): Set<string> {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
    if (fromModules && !fromModules.has(from)) continue;
    for (const element of statement.exportClause.elements) names.add(element.name.text);
  }
  return names;
}

describe('BUG-711: the headless entry re-exports the whole server-node public surface', () => {
  const serverNames = exportedNames(join(__dirname, '..', 'server-node', 'index.ts'), new Set(['./client', './types']));
  const headlessNames = exportedNames(join(__dirname, 'headless.ts'), new Set(['../server-node']));

  it('finds the server surface (the walk is not vacuous)', () => {
    expect(serverNames.has('RevTurbineServer')).toBe(true);
    expect(serverNames.has('CreateClientSessionInput')).toBe(true);
    expect(serverNames.size).toBeGreaterThan(20);
  });

  it('every server-node public name is re-exported from headless', () => {
    const missing = [...serverNames].filter((name) => !headlessNames.has(name));
    expect(missing).toEqual([]);
  });
});
