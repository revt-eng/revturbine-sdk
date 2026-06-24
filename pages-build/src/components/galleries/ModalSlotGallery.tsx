import React from 'react';
import { StoryRendererCore } from '../StoryRenderer';
import storyMeta, * as stories from '../../../../web-sdk/placements/slots/ModalSlot.stories';

const { default: _, ...namedStories } = stories as Record<string, unknown>;

export default function ModalSlotGallery() {
  return <StoryRendererCore meta={storyMeta} stories={namedStories as Record<string, { args?: Record<string, unknown> }>} />;
}
