export const PLAN_HANDLES = ['starter', 'professional', 'enterprise'] as const;
export type PlanHandle = (typeof PLAN_HANDLES)[number];

export const DEMO_USER_IDS = [
  'user_alice',
  'user_bob',
  'user_carol',
  'user_dan',
  'user_eve',
  'user_frank',
] as const;
export type DemoUserId = (typeof DEMO_USER_IDS)[number];
