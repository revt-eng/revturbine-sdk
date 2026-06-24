import React from 'react';
import { StoryRendererCore } from '../StoryRenderer';
import storyMeta, * as stories from '../../../../web-sdk/placements/slots/BannerSlot.stories';

const { default: _, ...namedStories } = stories as Record<string, unknown>;

export default function BannerSlotGallery() {
  return <StoryRendererCore meta={storyMeta} stories={namedStories as Record<string, { args?: Record<string, unknown> }>} />;
}
