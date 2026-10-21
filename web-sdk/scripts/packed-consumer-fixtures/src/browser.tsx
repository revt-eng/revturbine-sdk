// BUG-711 consumer fixture — the React root entry. Shared types must be
// importable here too, and React-only props must type-check.
import { RevTurbineProvider, Gate, Slot, useCan, RevTurbineServer } from '@revturbine/sdk';
import type {
  CreateClientSessionInput,
  ClientSessionResult,
  EntitlementResult,
  GateProps,
  RevTurbineProviderProps,
} from '@revturbine/sdk';

type IsAny<T> = 0 extends 1 & T ? true : false;
export const notAny: [IsAny<GateProps>, IsAny<RevTurbineProviderProps>, IsAny<CreateClientSessionInput>, IsAny<EntitlementResult>] = [
  false,
  false,
  false,
  false,
];

export type SessionTypes = [CreateClientSessionInput, ClientSessionResult, typeof RevTurbineServer];

function ExportButton() {
  const { can, isLoading } = useCan('export');
  return <button disabled={isLoading || !can}>Export</button>;
}

export function App() {
  return (
    <RevTurbineProvider options={{ publicKey: 'rtk_public_key', tenantId: 'tenant_1' }}>
      <Gate id="sso_gate" can="sso">
        <span>SSO settings</span>
      </Gate>
      <Slot id="home_banner" />
      <ExportButton />
    </RevTurbineProvider>
  );
}

export function Negative() {
  return (
    <>
      {/* @ts-expect-error Gate's `can` is an entitlement handle string */}
      <Gate id="bad_gate" can={123}>
        <span />
      </Gate>
      {/* @ts-expect-error the provider requires options */}
      <RevTurbineProvider>
        <span />
      </RevTurbineProvider>
    </>
  );
}
