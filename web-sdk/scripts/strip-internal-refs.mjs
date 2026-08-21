#!/usr/bin/env node
/**
 * strip-internal-refs.mjs — keep internal plan references out of shipped types.
 *
 * The SDK's TSDoc cites the plan, TASK, REQ, AC and Q that produced each
 * decision. That traceability is genuinely useful to a maintainer — it is how
 * you find out WHY a surface looks the way it does — and it is noise to a
 * customer, who meets it as "(plan 191 REQ-3)" in IDE hover text.
 *
 * So rather than strip the citations from source (losing traceability) or ship
 * them (leaking internal process), this rewrites the EMITTED `.d.ts`: source
 * keeps its citations, the published types do not.
 *
 * Conservative by construction. It removes citations, never surrounding prose:
 * a parenthetical that also carries a real qualifier keeps the qualifier
 * (`(plan 191 Q-1, amended)` → `(amended)`), and only a parenthetical that was
 * nothing but citations disappears. A doc line cannot lose meaning by being
 * cleaned.
 *
 * SCOPE. This removes citation DECORATIONS — a trailing parenthetical or an
 * em-dashed suffix. Prose that genuinely discusses a plan mid-sentence
 * ("until plan 181's data-dictionary lands") is left alone: rewriting that
 * safely means rewriting the sentence, which belongs at source, not in a
 * post-process. Same for a parenthetical split across two lines.
 *
 *   node web-sdk/scripts/strip-internal-refs.mjs <dist-dir>
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('usage: strip-internal-refs.mjs <dist-dir>');
  process.exit(1);
}

/** `plan 191`, `plan-139`, `TASK-9`, `REQ-3`, `AC-13`, `Q-6`, `F-73`. */
const REF = '(?:plan[ -]\\d+[a-z]?|TASK-\\d+[a-z]?|REQ-\\d+[a-z]?|AC-\\d+[a-z]?|Q-\\d+[a-z]?|F-\\d+)';
const CITATION_RUN = `(?:see\\s+)?${REF}(?:[ ,/]+${REF})*`;

/** `— plan 194 TASK-9` trailing a clause. */
const TRAILING = new RegExp(`\\s*[—-]\\s*${CITATION_RUN}(?=[.,;]|\\s*$)`, 'gi');
/** `pre-plan-139` used adjectivally: keep the shape, drop the number. */
const ADJECTIVAL = /\bpre-plan-\d+\b/gi;

/** Strip citations from inside a parenthetical, keeping any real prose. */
function cleanParenthetical(line) {
  return line.replace(/\s*\(([^()]*)\)/g, (whole, inner) => {
    if (!new RegExp(REF, 'i').test(inner)) return whole;
    const rest = inner
      .replace(new RegExp(CITATION_RUN, 'gi'), '')
      .replace(/^[\s,;/—-]+|[\s,;/—-]+$/g, '')
      .trim();
    return rest ? ` (${rest})` : '';
  });
}

function declFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) declFiles(full, out);
    else if (entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

let changedFiles = 0;
let cleaned = 0;

for (const file of declFiles(target)) {
  const before = readFileSync(file, 'utf8');
  const after = before
    .split('\n')
    .map((line) => {
      // Only doc-comment prose — never code, never a `//` line comment (those
      // do not reach a .d.ts anyway). Single-line `/** … */` counts: it is the
      // common shape for `@deprecated` notes, and keying on a leading `*`
      // alone skipped every one of them.
      if (!/^\s*\*/.test(line) && !/^\s*\/\*\*/.test(line)) return line;
      let next = cleanParenthetical(line);
      next = next.replace(TRAILING, '');
      next = next.replace(ADJECTIVAL, 'previous');
      if (next !== line) cleaned += 1;
      // A line reduced to a bare `*` carried only a citation.
      if (/^\s*\*\s*$/.test(next) && !/^\s*\*\s*$/.test(line)) return null;
      return next;
    })
    .filter((line) => line !== null)
    .join('\n');

  if (after !== before) {
    writeFileSync(file, after);
    changedFiles += 1;
  }
}

console.log(
  `[strip-internal-refs] cleaned ${cleaned} citation(s) across ${changedFiles} declaration file(s)`,
);
