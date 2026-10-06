#!/usr/bin/env node
/**
 * gen-reason-codes.mjs — regenerate the placement reason-code tables from the
 * public reason contract (BL-0407).
 *
 * `../tests/reason-contract.json` is the canonical list of placement reason
 * codes the SDK is allowed to emit (enforced against live fixtures by
 * `web-sdk/reason-contract.test.ts`). The docs used to hand-maintain their own
 * copy of that table and drifted: it documented codes the SDK had stopped
 * emitting years ago (`api_error`, `fallback_content`) and never mentioned most
 * of the codes users actually receive (`no_eligible_candidate`,
 * `entitlement_gate_unmet`, the `suppressed_by_payload_cap_*` family, ...).
 *
 * This script renders a `Code | Meaning` table from the contract into both
 * `src/content/docs/reference/errors.md` and
 * `src/content/docs/guides/error-handling.md`, replacing the content between
 * a pair of marker comments so the rest of each page (prose, other tables,
 * examples) is untouched.
 *
 * DESCRIPTIONS below is a hand-written one-sentence gloss per code. Every
 * sentence is derived from the emitting call site (a grep through
 * `@revt-eng/core`'s published dist and `web-sdk/customer-side.ts` for the
 * literal string) or from that call site's own comments — never invented.
 * When the contract adds or removes a placement code, this script's assertion
 * step fails loudly until DESCRIPTIONS is updated to match, so the mapping
 * can't silently go stale the way the old hand-written tables did.
 *
 * Usage:
 *   node scripts/gen-reason-codes.mjs          # write the regenerated tables
 *   node scripts/gen-reason-codes.mjs --check  # exit 1 if a file would change
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const REPO_ROOT = join(ROOT, '..');
const CONTRACT_PATH = join(REPO_ROOT, 'tests', 'reason-contract.json');

export const MARKER_BEGIN = '<!-- BEGIN GENERATED: placement-reason-codes (scripts/gen-reason-codes.mjs) -->';
export const MARKER_END = '<!-- END GENERATED: placement-reason-codes -->';

/**
 * One sentence per placement reason code, sourced from the emitting call site.
 * Keys must exactly match `tests/reason-contract.json`'s `placement` array —
 * `assertDescriptionsMatchContract()` enforces that in both directions.
 */
export const DESCRIPTIONS = {
  config_unavailable:
    'The Playbook could not be fetched, or a fetch is still in flight — the SDK has no config to decide against yet.',
  entitlement_not_denied:
    "The Access Gate placement's entitlement is not denied or limited for this user, so the gate does not fire.",
  entitlement_gate_unmet:
    "The candidate's entitlement-gate trigger did not match the user's current entitlement state.",
  gate_outside_access_gate:
    'An Access Gate placement was requested from a slot that is not an Access Gate slot; gates render only in gate slots.',
  no_eligible_candidate:
    'No candidate placement survived eligibility filtering for this slot.',
  no_gate_for_entitlement:
    'The Access Gate slot asks for an entitlement that no gate placement is authored for, so the slot shows its access-denied placeholder.',
  no_resolver_configured:
    'No placement resolver is configured, so the SDK has nothing to evaluate against.',
  placement_not_found:
    'No candidate output matched the requested placement id or name.',
  placement_not_registered:
    "The payload targets a placement handle the app never registered with the SDK.",
  placement_retired:
    "The candidate's rule is hidden — for example, superseded by a conversion — per impression history.",
  plan_target_mismatch:
    "The user's plan or billing period doesn't match the candidate's plan targeting.",
  qualifier_trigger_unmet:
    "The candidate's qualifier trigger condition was not satisfied for the user's plan or category.",
  sdk_disabled_provider_failure:
    'The SDK disabled itself after its configured providers failed, so it fails closed rather than risk showing something wrong.',
  segment_target_mismatch:
    "The user doesn't belong to any of the candidate's target segments.",
  suppressed_by_dismiss_cooldown:
    'The user dismissed this placement and its cooldown window has not elapsed.',
  suppressed_by_payload_cap_day:
    "The payload's per-day impression cap has been reached.",
  suppressed_by_payload_cap_lifetime:
    "The payload's lifetime impression cap has been reached.",
  suppressed_by_payload_cap_month:
    "The payload's per-month impression cap has been reached.",
  suppressed_by_payload_cap_session:
    "The payload's per-session impression cap has been reached.",
  suppressed_by_payload_cap_week:
    "The payload's per-week impression cap has been reached.",
  suppressed_by_payload_cooldown:
    'The payload is still inside its configured cooldown window since it was last shown.',
  suppressed_by_presentation_cap:
    'Every eligible candidate is over an overall presentation cap rule from Placement Settings.',
  suppressed_by_system_cooldown:
    'Every eligible candidate is a discretionary nudge inside the session cooldown since the last one shown.',
  suppressed_until_remind_window:
    'The user chose "remind me later" and that reminder window has not elapsed yet.',
  threshold_trigger_unmet:
    "The candidate's threshold trigger did not match the user's current entitlement usage.",
  trial_trigger_unmet:
    "The candidate's trial trigger did not match the user's trial state.",
};

export function loadContract() {
  return JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
}

/** Fails loudly if DESCRIPTIONS and the contract's placement codes diverge. */
export function assertDescriptionsMatchContract(contract) {
  const contractCodes = new Set(contract.placement);
  const describedCodes = new Set(Object.keys(DESCRIPTIONS));
  const undocumented = contract.placement.filter((c) => !describedCodes.has(c));
  const stale = [...describedCodes].filter((c) => !contractCodes.has(c));
  if (undocumented.length > 0 || stale.length > 0) {
    const lines = [];
    if (undocumented.length > 0) {
      lines.push(`  contract codes missing a DESCRIPTIONS entry: ${undocumented.join(', ')}`);
    }
    if (stale.length > 0) {
      lines.push(`  DESCRIPTIONS entries no longer in the contract: ${stale.join(', ')}`);
    }
    throw new Error(
      `gen-reason-codes.mjs: DESCRIPTIONS is out of sync with tests/reason-contract.json:\n${lines.join('\n')}\n` +
      'Update DESCRIPTIONS (one sourced sentence per code) before regenerating.',
    );
  }
}

export function renderTable(contract) {
  const codes = [...contract.placement].sort();
  const rows = codes.map((code) => `| \`${code}\` | ${DESCRIPTIONS[code]} |`);
  return [
    MARKER_BEGIN,
    '',
    '| Code | Meaning |',
    '|---|---|',
    ...rows,
    '',
    MARKER_END,
  ].join('\n');
}

/** Replaces the marker-delimited block in `content` with `table`. Throws if markers are missing/malformed. */
export function applyTable(content, table, file) {
  const begin = content.indexOf(MARKER_BEGIN);
  const end = content.indexOf(MARKER_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${file}: missing or malformed generated-block markers (expected ${MARKER_BEGIN} ... ${MARKER_END})`);
  }
  return content.slice(0, begin) + table + content.slice(end + MARKER_END.length);
}

const TARGETS = [
  join(ROOT, 'src', 'content', 'docs', 'reference', 'errors.md'),
  join(ROOT, 'src', 'content', 'docs', 'guides', 'error-handling.md'),
];

function main() {
  const checkOnly = process.argv.includes('--check');
  const contract = loadContract();
  assertDescriptionsMatchContract(contract);
  const table = renderTable(contract);

  let stale = [];
  for (const file of TARGETS) {
    const before = readFileSync(file, 'utf8');
    const after = applyTable(before, table, file);
    if (after !== before) {
      stale.push(file);
      if (!checkOnly) writeFileSync(file, after);
    }
  }

  if (checkOnly) {
    if (stale.length > 0) {
      console.error('✗ Placement reason-code tables are out of date with tests/reason-contract.json:');
      for (const f of stale) console.error(`  • ${f}`);
      console.error('\nRun `node scripts/gen-reason-codes.mjs` (from pages-build/) to regenerate.');
      process.exit(1);
    }
    console.log('✓ Placement reason-code tables match tests/reason-contract.json.');
  } else {
    console.log(stale.length > 0
      ? `✓ Regenerated ${stale.length} file(s) from tests/reason-contract.json.`
      : '✓ Placement reason-code tables already up to date.');
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
