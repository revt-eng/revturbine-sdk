import type { InlineEmbedSlotProps } from './InlineEmbedSlot';
import { InlineEmbedSlot } from './InlineEmbedSlot';

/**
 * Explicit in-page surface renderer.
 *
 * This is the canonical SDK component for the `in_page` surface type.
 * It wraps `InlineEmbedSlot` for backwards compatibility.
 */
export type InPageSlotProps = InlineEmbedSlotProps;

export function InPageSlot(props: InPageSlotProps) {
  return <InlineEmbedSlot {...props} />;
}

InPageSlot.displayName = 'InPageSlot';