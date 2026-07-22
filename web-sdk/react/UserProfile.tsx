'use client';

import React from 'react';
import { useRevTurbineTheme } from '../theme/ThemeContext';
import type { RevTurbineTargeting } from '../customer-side';

/**
 * Props for {@link UserProfile}.
 */
export interface UserProfileProps {
  /** Targeting/user context snapshot to render. */
  targeting: RevTurbineTargeting;
  /** Optional heading override. */
  title?: string;
  /** Optional class name for root container. */
  className?: string;
  /** Optional inline styles for root container. */
  style?: React.CSSProperties;
}

/**
 * Read-only visualization of the resolved SDK user context.
 *
 * Displays user id, plan, matched segments, usage balances, and traits that
 * were used for segment evaluation and placement decisioning.
 */
export function UserProfile({
  targeting,
  title = 'User Profile',
  className,
  style,
}: UserProfileProps) {
  const c = useRevTurbineTheme().colors;
  const usageEntries = Object.entries(targeting.usage ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const traitEntries = Object.entries(targeting.traits ?? {}).sort(([left], [right]) => left.localeCompare(right));

  return (
    <section
      className={className}
      style={{
        border: `1px solid ${c.surfaceBorder}`,
        borderRadius: 8,
        padding: 10,
        background: c.surface,
        // Set explicitly rather than inherited: this card sets its own surface,
        // so inheriting a caller's text colour is how it ended up light-on-light
        // the moment the inspector around it went dark.
        color: c.text,
        ...style,
      }}
      data-rt-inspector="user-profile"
    >
      <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>{title}</h4>

      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        <div>userId: <code>{targeting.userId}</code></div>
        <div>plan: <strong>{targeting.plan ?? 'n/a'}</strong></div>
        <div>
          matched segments: {targeting.segmentIds.length > 0 ? targeting.segmentIds.join(', ') : 'none'}
        </div>
      </div>

      {usageEntries.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>Usage ({usageEntries.length})</summary>
          <ul style={{ margin: '6px 0 0 18px', fontSize: 12 }}>
            {usageEntries.map(([key, value]) => (
              <li key={key}>{key}: {String(value)}</li>
            ))}
          </ul>
        </details>
      )}

      {traitEntries.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>Traits ({traitEntries.length})</summary>
          <ul style={{ margin: '6px 0 0 18px', fontSize: 12 }}>
            {traitEntries.map(([key, value]) => (
              <li key={key}>{key}: {JSON.stringify(value)}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
