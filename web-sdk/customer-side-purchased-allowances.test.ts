import { afterEach, expect, it, vi } from 'vitest';
import { PlaybookSchema } from '@revt-eng/schema';
import { RevTurbineCustomerSdk } from './customer-side';

const playbook = () => PlaybookSchema.parse({
  artifact_type: 'playbook', format_version: '1.0.0', tenant_id: 'tenant_addons', environment_id: 'production',
  plans: [{ unique_handle: 'pro', name: 'Pro' }],
  addons: [{ unique_handle: 'pack', name: 'Pack' }],
  entitlements: [{ unique_handle: 'calls', name: 'Calls', type: 'usage_limit' }],
  entitlement_rules: [
    { id: 'base', entitlement_id: 'calls', targets: [{ kind: 'plan', id: 'pro' }], limit_value: 1000, period_scope: 'per_month', enforcement: 'hard_block' },
    { id: 'extra', entitlement_id: 'calls', targets: [{ kind: 'addon', id: 'pack' }], limit_value: 500, period_scope: 'per_month', enforcement: 'hard_block' },
  ],
  segments: [], content_ui_paths: [],
});

function sdk() {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_addons', environmentId: 'production', publicKey: 'pub_test',
    endpoint: 'https://edge.example.com', mode: 'snippet', runtimeMode: 'local_only',
    localRuntime: { playbook: playbook() },
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    user: { id: 'u', plan_handle: 'pro' },
  });
}

afterEach(() => vi.unstubAllGlobals());

it('updates current purchases and clears them across the public SDK boundary', async () => {
  const client = sdk();
  client.update({ addons: [{ addon_handle: 'pack', quantity: 2 }] });
  expect(await client.checkEntitlement('calls')).toMatchObject({ limit: 2000 });
  client.update({ addons: [{ addon_handle: 'pack', quantity: 1 }] });
  expect(await client.checkEntitlement('calls')).toMatchObject({ limit: 1500 });
  client.update({ addons: [] });
  expect(await client.checkEntitlement('calls')).toMatchObject({ limit: 1000 });
  client.identify('u', { addons: [{ addon_handle: 'pack', quantity: 2 }] });
  expect(await client.checkEntitlement('calls')).toMatchObject({ limit: 2000 });
  client.identify('other', { plan_handle: 'pro' });
  expect(await client.checkEntitlement('calls')).toMatchObject({ limit: 1000 });
});

it('applies quantity-only HTTP refreshes and clears purchases without a plan change', async () => {
  const client = sdk();
  let quantity = 2;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    subject: 'u', context_version: 'same', plan: { handle: 'pro', name: 'Pro' },
    addons: quantity ? [{ addon_handle: 'pack', quantity, provider_subscription_item_id: 'must_not_be_kept' }] : [],
  }), { status: 200, headers: { 'content-type': 'application/json' } })));
  await client.fetchClientContext('rt_client_test');
  expect(await client.checkEntitlement('calls')).toMatchObject({ limit: 2000 });
  quantity = 1;
  await client.fetchClientContext();
  expect(await client.checkEntitlement('calls')).toMatchObject({ limit: 1500 });
  quantity = 0;
  await client.fetchClientContext();
  expect(await client.checkEntitlement('calls')).toMatchObject({ limit: 1000 });
});
