/**
 * Type-level regression for BL-0172.
 *
 * The papercut: several SDK-side option bags carry the `playbook` /
 * deprecated `exportedConfig` alias through a *union* of two required-either
 * arms, mirroring scaffold's `PlaybookOption` (BL-0156). `BrowserRuntimeOptions`
 * and `LocalEvaluationServerOptions` already repeated the `@deprecated` tag on
 * every arm; the customer-facing `localRuntime` init option in
 * `customer-side.ts` did not — `RevTurbineInitOptionsStrict`'s
 * local-only-with-a-Playbook arm (and the identically-shaped
 * `createLocalRuntimeConfig` / `createStrictLocalRuntimeConfig` overloads)
 * declared `exportedConfig` with no JSDoc at all, so it type-checked but drew
 * no IDE strikethrough — exactly the gap #522 reports.
 *
 * A unit test cannot see an IDE decoration, so this asks the same authority
 * the editor asks: the TypeScript checker. For each bag, it resolves the
 * real property symbol for `.exportedConfig` and asserts every declaration
 * contributing to that symbol carries a `@deprecated` JSDoc tag — which is
 * exactly the condition `playbook-deprecation-arms.fixture.ts` exercises via
 * a genuine property access on each type. Reverting any of the three tags
 * added to `customer-side.ts`, or either pre-existing tag on
 * `BrowserRuntimeOptions` / `LocalEvaluationServerOptions`, fails this test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const testFileDirectory = dirname(
  new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'),
);
const fixturePath = join(testFileDirectory, 'playbook-deprecation-arms.fixture.ts');

function loadCompilerOptions(): ts.CompilerOptions {
  const configPath = join(testFileDirectory, 'tsconfig.typetests.json');
  const configFile = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'));
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, testFileDirectory);
  return parsed.options;
}

const program = ts.createProgram([fixturePath], loadCompilerOptions());
const checker = program.getTypeChecker();
const fixtureSourceFile = program.getSourceFile(fixturePath);
if (!fixtureSourceFile) {
  throw new Error(`Program did not include the fixture file: ${fixturePath}`);
}

/** The type of a `declare function`'s (only) parameter, by function name. */
function soleParameterType(functionName: string): ts.Type {
  let result: ts.Type | undefined;
  ts.forEachChild(fixtureSourceFile!, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      const [firstParameter] = node.parameters;
      if (!firstParameter) throw new Error(`${functionName} has no parameters.`);
      result = checker.getTypeAtLocation(firstParameter);
    }
  });
  if (!result) throw new Error(`No \`declare function ${functionName}\` found in the fixture.`);
  return result;
}

/**
 * True only if every declaration contributing to the resolved
 * `exportedConfig` property symbol on `type` carries a `@deprecated` JSDoc
 * tag. A union property's symbol carries one declaration per constituent
 * arm that declares the property, so this fails the moment any arm omits
 * the tag — the exact shape of the BL-0172 papercut.
 */
function exportedConfigIsDeprecatedOnEveryDeclaration(type: ts.Type): boolean {
  const property = checker.getPropertyOfType(type, 'exportedConfig');
  if (!property?.declarations?.length) {
    throw new Error('Resolved type has no `exportedConfig` property — fixture or type drifted.');
  }
  return property.declarations.every((declaration) =>
    ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === 'deprecated'),
  );
}

describe('exportedConfig deprecation surfaces on every SDK option bag (BL-0172)', () => {
  it.each([
    ['RevTurbineInitOptionsStrict.localRuntime', 'useInitOptionsStrictLocalRuntime'],
    ['BrowserRuntimeOptions', 'useBrowserRuntimeOptions'],
    ['LocalEvaluationServerOptions', 'useLocalEvaluationServerOptions'],
  ] as const)('marks `.exportedConfig` @deprecated on every arm for %s', (_bagName, functionName) => {
    const type = soleParameterType(functionName);
    expect(exportedConfigIsDeprecatedOnEveryDeclaration(type)).toBe(true);
  });
});
