// BUG-711 consumer fixture — the Node server / headless entry, React-free.
// Compiled against the PACKED public package by check-packed-consumer.mjs.
import {
  RevTurbineServer,
  RevTurbineClientSessionError,
  RevTurbineSeatAssignmentError,
  RevTurbineDimensionWriteError,
  RevTurbineBuiltinDimensionsError,
  initRevTurbine,
} from '@revturbine/sdk/headless';
import type {
  RevTurbineServerOptions,
  CreateClientSessionInput,
  ClientSessionResult,
  AssignSeatTypeOptions,
  SetBuiltinDimensionsOptions,
  ServerBuiltinDimensionsWrite,
  ServerUserBuiltinDimensions,
  ServerUserContextAssignment,
  ServerEntitlementResult,
  ServerEvaluationPayload,
  EntitlementResult,
  RevTurbineCustomerSdk,
} from '@revturbine/sdk/headless';

type IsAny<T> = 0 extends 1 & T ? true : false;
export const notAny: [
  IsAny<CreateClientSessionInput>,
  IsAny<ClientSessionResult>,
  IsAny<AssignSeatTypeOptions>,
  IsAny<SetBuiltinDimensionsOptions>,
  IsAny<ServerBuiltinDimensionsWrite>,
  IsAny<ServerUserBuiltinDimensions>,
  IsAny<ServerUserContextAssignment>,
  IsAny<ServerEntitlementResult>,
  IsAny<ServerEvaluationPayload>,
  IsAny<EntitlementResult>,
  IsAny<RevTurbineServerOptions>,
] = [false, false, false, false, false, false, false, false, false, false, false];

const options: RevTurbineServerOptions = {
  tenantId: 'tenant_1',
  apiKey: 'rtk_server_key',
  endpoint: 'https://revturbine.com/app',
};
const server = new RevTurbineServer(options);

export async function positive(): Promise<string> {
  const input: CreateClientSessionInput = { subject: 'user_1', surface: 'billing' };
  const session: ClientSessionResult = await server.createClientSession(input);
  const seat: AssignSeatTypeOptions = { override: true };
  const assigned: ServerUserContextAssignment = await server.assignSeatType('user_1', 'admin', seat);
  const dimensionOptions: SetBuiltinDimensionsOptions = { override: false };
  const write: ServerBuiltinDimensionsWrite = { subscription_state: null };
  await server.setBuiltinDimensions('user_1', write, dimensionOptions);
  const read: ServerUserBuiltinDimensions = await server.getBuiltinDimensions('user_1');
  void assigned;
  void read;
  try {
    await server.createClientSession(input);
  } catch (error) {
    if (error instanceof RevTurbineClientSessionError) return error.message;
    if (
      error instanceof RevTurbineSeatAssignmentError
      || error instanceof RevTurbineDimensionWriteError
      || error instanceof RevTurbineBuiltinDimensionsError
    ) {
      return error.message;
    }
  }
  return session.client_token;
}

export async function entitlementCheck(sdk: RevTurbineCustomerSdk): Promise<boolean> {
  const result: EntitlementResult = await sdk.can('export');
  return result.allowed && result.status !== 'denied';
}

export async function negative(sdk: RevTurbineCustomerSdk): Promise<void> {
  // @ts-expect-error a numeric session subject is rejected
  await server.createClientSession({ subject: 123 });
  // @ts-expect-error an entitlement handle is a string
  await sdk.can(123);
  // @ts-expect-error a built-in dimension value of the wrong type is rejected
  await server.setBuiltinDimensions('user_1', { subscription_state: 42 });
  // @ts-expect-error the server options require an apiKey
  void new RevTurbineServer({ tenantId: 'tenant_1', endpoint: 'https://revturbine.com/app' });
  // @ts-expect-error a malformed Playbook is rejected
  await initRevTurbine({ tenantId: 'tenant_1', localRuntime: { playbook: { plans: 'not-a-list' } } });
}
