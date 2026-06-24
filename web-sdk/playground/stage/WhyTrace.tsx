import { traceFor } from '../state/capability-trace';

/**
 * The per-surface "why am I seeing this?" decision trace (plan 81 TASK-7).
 * A collapsible affordance that maps the surface (by slot id or placement id)
 * to the RevTurbine capability it demonstrates, the condition that fired it, and
 * the defining spec — so the playground teaches, not just renders.
 */
export function WhyTrace({ id }: { id: string }) {
  const trace = traceFor(id);
  if (!trace) return null;
  return (
    <details className="prism-why">
      <summary>Why am I seeing this?</summary>
      <dl className="prism-why__body">
        <div>
          <dt>Capability</dt>
          <dd>{trace.capability}</dd>
        </div>
        <div>
          <dt>Trigger</dt>
          <dd>{trace.why}</dd>
        </div>
        <div>
          <dt>Spec</dt>
          <dd>{trace.spec}</dd>
        </div>
      </dl>
    </details>
  );
}
