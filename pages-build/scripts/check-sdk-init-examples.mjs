import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const retiredModes = new Set(['local_only', 'revturbine_server', 'custom_endpoints']);

/** Find retired runtime selectors without rejecting integration labels or nested local settings. */
export function findRetiredInitOptions(code) {
  const source = ts.createSourceFile('example.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const owner = node.parent;
      const nestedLocal = ts.isPropertyAssignment(owner) && owner.name.getText(source) === 'localRuntime';
      if (!nestedLocal) {
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : '';
          if (name !== 'mode') continue;
          const value = property.initializer;
          if ((ts.isStringLiteral(value) && retiredModes.has(value.text))
            || (ts.isPropertyAccessExpression(value) && value.expression.getText(source) === 'RuntimeMode')) {
            findings.push({ line: source.getLineAndCharacterOfPosition(property.getStart()).line + 1,
              message: 'Use runtimeMode for runtime selection; mode is an integration label.' });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

function scan(directory) {
  const findings = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'api') findings.push(...scan(file));
    else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/```(?:ts|tsx|typescript|javascript|js)[^\n]*\n([\s\S]*?)```/g)) {
        for (const finding of findRetiredInitOptions(match[1])) {
          const line = text.slice(0, match.index).split('\n').length + finding.line;
          findings.push(`${file}:${line}: ${finding.message}`);
        }
      }
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scan(fileURLToPath(new URL('../src/content/docs/', import.meta.url)));
  if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
  else console.log('SDK initialization examples use current runtime selectors.');
}
