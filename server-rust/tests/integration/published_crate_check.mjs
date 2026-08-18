// Integration check for the *published* `revturbine` crate (plan 185 TASK-11).
//
// Rust parallel of `server-python/tests/integration/published_sdk_check.py` and
// `tests/integration/published-sdk.test.mjs`. Creates a throwaway cargo project
// that depends on the crate **from crates.io** — never a path dependency on this
// working tree — then runs the headless `RevTurbineCustomerSdk` surface in it and
// asserts behavior.
//
// The point is to catch what a green in-repo test suite structurally cannot: a
// published artifact that is missing a module, exports a different surface than
// the source tree, or does not build from a clean registry fetch.
//
// It is deliberately NOT a `cargo test` target — `cargo test` compiles the local
// crate, which is exactly the thing under suspicion. Run it manually, or from a
// post-publish CI job:
//
//     node server-rust/tests/integration/published_crate_check.mjs
//     node server-rust/tests/integration/published_crate_check.mjs 0.2.86
//     REVTURBINE_CRATE_VERSION=0.2.86 node server-rust/tests/integration/published_crate_check.mjs
//
// With no version given it reads `server-rust/Cargo.toml` — i.e. "is the version
// I am about to ship (or just shipped) actually good on crates.io?"
//
// Exit code 0 = all assertions passed; non-zero = failure (CI-gating).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CRATE_ROOT = join(HERE, '..', '..');

/** The scenario the installed crate must satisfy. Emits one JSON object per check. */
const MAIN_RS = String.raw`
use revturbine::runtime::PlacementDecisionInput;
use revturbine::sdk::{RevTurbineCustomerSdk, UserContext};
use serde_json::{json, Value};

fn main() {
    let cfg = json!({
        "version": "1.0.0",
        "plans": [],
        "entitlements": [
            { "unique_handle": "feat_x", "unit": null },
            { "unique_handle": "credits", "unit": "credit" }
        ],
        "entitlement_rules": [],
        "segments": [],
        "content_ui_paths": [],
        "placements": [{ "placement_id": "pl_known", "name": "Known" }]
    });

    let user = UserContext {
        tenant_id: "t".to_string(),
        user_id: "u".to_string(),
        plan_handle: Some("pro".to_string()),
        ..Default::default()
    };
    let mut sdk = RevTurbineCustomerSdk::new(&user, &cfg).expect("construct from playbook");

    let ent = sdk.check_entitlement("feat_x", None);
    println!("{}", json!({
        "check": "entitlement",
        "allowed": ent.allowed,
        "status": ent.status,
    }));

    let dec = sdk.get_placement_decision(&PlacementDecisionInput {
        placement_id: "pl_known".to_string(),
        user_id: "u".to_string(),
    });
    println!("{}", json!({
        "check": "placement",
        "placement_id": dec.get("placement_id").cloned().unwrap_or(Value::Null),
        "has_visible": dec.get("visible").is_some(),
    }));

    let batch = sdk.get_placement_decisions(&[
        PlacementDecisionInput { placement_id: "pl_known".to_string(), user_id: "u".to_string() },
        PlacementDecisionInput { placement_id: "missing".to_string(), user_id: "u".to_string() },
    ]);
    println!("{}", json!({
        "check": "batch_order",
        "order": batch.iter()
            .map(|d| d.get("placement_id").cloned().unwrap_or(Value::Null))
            .collect::<Vec<_>>(),
    }));
}
`;

function resolveVersion() {
  const raw = process.env.REVTURBINE_CRATE_VERSION || process.argv[2];
  if (raw) return raw.trim();
  const toml = readFileSync(join(CRATE_ROOT, 'Cargo.toml'), 'utf8');
  const m = toml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error('could not read version from server-rust/Cargo.toml');
  return m[1];
}

function main() {
  const version = resolveVersion();
  // Built OUTSIDE the repo: inside it, cargo would find the workspace and could
  // resolve `revturbine` to the local crate — silently testing the working tree
  // instead of the published artifact, which is the one thing this must not do.
  const tmp = mkdtempSync(join(tmpdir(), 'revturbine-crate-check-'));
  const proj = join(tmp, 'consumer');
  let passed = 0;
  let failed = 0;

  const check = (cond, label) => {
    if (cond) {
      passed += 1;
      console.log(`  [ok] ${label}`);
    } else {
      failed += 1;
      console.error(`  [FAIL] ${label}`);
    }
  };

  try {
    console.log(`-> building a clean consumer against revturbine ${version} from crates.io`);
    const run = (args, opts = {}) =>
      execFileSync('cargo', args, { encoding: 'utf8', ...opts });

    run(['new', '--quiet', '--bin', proj]);
    // `--registry`-free add: resolves from crates.io, so a version that never
    // published (or was yanked) fails HERE, loudly, rather than at a customer.
    run(['add', `revturbine@=${version}`, 'serde_json'], { cwd: proj, stdio: 'inherit' });
    writeFileSync(join(proj, 'src', 'main.rs'), MAIN_RS, 'utf8');

    const stdout = run(['run', '--quiet'], { cwd: proj });

    const results = {};
    for (const line of stdout.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && obj.check) results[obj.check] = obj;
      } catch {
        /* not one of ours */
      }
    }

    // The Python check asserts each method is exported via `getattr`. Rust has no
    // runtime equivalent and does not need one: a missing or renamed item is a
    // COMPILE error, so reaching this line at all IS the export assertion.
    check(true, 'public surface compiles against the published crate');

    const ent = results.entitlement ?? {};
    check(ent.allowed === true, 'feat_x entitlement allowed (static-allow)');
    check(ent.status === 'allowed', 'feat_x status == allowed');

    const plc = results.placement ?? {};
    check(plc.placement_id === 'pl_known', 'placement_id round-trips');
    check(plc.has_visible === true, "placement decision carries 'visible'");

    const batch = results.batch_order ?? {};
    check(
      JSON.stringify(batch.order) === JSON.stringify(['pl_known', 'missing']),
      'get_placement_decisions preserves order',
    );
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${err.message}`);
    if (err.stdout) console.error(err.stdout.toString());
    if (err.stderr) console.error(err.stderr.toString());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n${'='.repeat(48)}\nResults: ${passed}/${total} passed\n${'='.repeat(48)}`);
  return failed ? 1 : 0;
}

process.exit(main());
