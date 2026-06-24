import { useMemo } from 'react';
import type { PlacementSlotProps } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';

type ConnectionState = 'connected' | 'pending' | 'disconnected';

export type AgentConnectorSlotProps = PlacementSlotProps & {
  connectionState?: ConnectionState;
};

function dotColorForState(state: ConnectionState): string {
  if (state === 'connected') return '#22c55e';
  if (state === 'pending') return '#f59e0b';
  return '#ef4444';
}

function stateLabel(state: ConnectionState): string {
  if (state === 'connected') return 'Connected';
  if (state === 'pending') return 'Pending';
  return 'Disconnected';
}

export function AgentConnectorSlot({
  content,
  onCtaClick,
  visible,
  className,
  style,
}: AgentConnectorSlotProps) {
  const theme = useRevTurbineTheme();
  const state = ((content.connection_state as string) || 'disconnected') as ConnectionState;

  const themedStyles = useMemo(() => {
    const { colors, typography, shape, shadows } = theme;
    return {
      card: {
        backgroundColor: colors.surface,
        border: `1px solid ${colors.surfaceBorder}`,
        borderRadius: shape.borderRadius,
        boxShadow: shadows.medium,
        padding: '16px',
        display: 'flex',
        flexDirection: 'column' as const,
        gap: '12px',
        fontFamily: typography.fontFamily,
        maxWidth: '420px',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
      },
      heading: {
        margin: 0,
        color: colors.text,
        fontSize: '15px',
        fontWeight: 600,
      },
      body: {
        margin: 0,
        color: colors.textSecondary,
        fontSize: typography.fontSizeSmall,
        lineHeight: 1.45,
      },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        borderRadius: '999px',
        border: `1px solid ${colors.surfaceBorder}`,
        padding: '3px 8px',
        fontSize: '12px',
        color: colors.textSecondary,
      },
      dot: {
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: dotColorForState(state),
      },
      cta: {
        alignSelf: 'flex-start',
        backgroundColor: colors.primary,
        color: colors.primaryText,
        border: 'none',
        borderRadius: shape.borderRadiusSmall,
        padding: '7px 12px',
        fontWeight: 600,
        fontSize: typography.fontSizeSmall,
        cursor: 'pointer',
      },
    } as const;
  }, [theme, state]);

  if (!visible) return null;

  return (
    <section className={className} style={{ ...themedStyles.card, ...style }} data-rt-placement="agent-connector">
      <div style={themedStyles.row}>
        <h3 style={themedStyles.heading}>{content.header || 'Connect your assistant'}</h3>
        <span style={themedStyles.badge}>
          <span style={themedStyles.dot} />
          {stateLabel(state)}
        </span>
      </div>
      <p style={themedStyles.body}>{content.body || 'Enable your agent connector to automate premium workflows.'}</p>
      {content.cta_label && (
        <button type="button" style={themedStyles.cta} onClick={onCtaClick}>
          {content.cta_label}
        </button>
      )}
    </section>
  );
}

AgentConnectorSlot.displayName = 'AgentConnectorSlot';