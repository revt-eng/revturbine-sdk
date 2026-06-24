import { useMemo } from 'react';
import {
  BannerSlot,
  type BannerSlotProps,
  ButtonSlot,
  type ButtonSlotProps,
  InPageSlot,
  type InPageSlotProps,
  ModalSlot,
  type ModalSlotProps,
  ToastSlot,
  type ToastSlotProps,
} from '../placements';
import { resolveContent } from '../placements/registry';
import type { PersonalizationContext, ResolvedContent } from '../placements/types';
import { usePlacementPersonalization } from '../placements/usePlacementPersonalization';

type SurfacePersonalizationProps = {
  userId?: string;
  personalization?: PersonalizationContext;
  personalizationRefreshKey?: string | number;
};

function useResolvedSurfaceContent(
  content: ResolvedContent,
  options: SurfacePersonalizationProps,
): ResolvedContent {
  const personalization = usePlacementPersonalization({
    userId: options.userId,
    personalization: options.personalization,
    refreshKey: options.personalizationRefreshKey,
  });

  return useMemo(
    () => resolveContent(content, personalization),
    [content, personalization],
  );
}

export type ButtonSurfaceProps = ButtonSlotProps & SurfacePersonalizationProps;

export function ButtonSurface({
  userId,
  personalization,
  personalizationRefreshKey,
  ...props
}: ButtonSurfaceProps) {
  const content = useResolvedSurfaceContent(props.content, {
    userId,
    personalization,
    personalizationRefreshKey,
  });
  return <ButtonSlot {...props} content={content} />;
}

export type InPageSurfaceProps = InPageSlotProps & SurfacePersonalizationProps;

export function InPageSurface({
  userId,
  personalization,
  personalizationRefreshKey,
  ...props
}: InPageSurfaceProps) {
  const content = useResolvedSurfaceContent(props.content, {
    userId,
    personalization,
    personalizationRefreshKey,
  });
  return <InPageSlot {...props} content={content} />;
}

export type BannerSurfaceProps = BannerSlotProps & SurfacePersonalizationProps;

export function BannerSurface({
  userId,
  personalization,
  personalizationRefreshKey,
  ...props
}: BannerSurfaceProps) {
  const content = useResolvedSurfaceContent(props.content, {
    userId,
    personalization,
    personalizationRefreshKey,
  });
  return <BannerSlot {...props} content={content} />;
}

export type ModalSurfaceProps = ModalSlotProps & SurfacePersonalizationProps;

export function ModalSurface({
  userId,
  personalization,
  personalizationRefreshKey,
  ...props
}: ModalSurfaceProps) {
  const content = useResolvedSurfaceContent(props.content, {
    userId,
    personalization,
    personalizationRefreshKey,
  });
  return <ModalSlot {...props} content={content} />;
}

export type ToastSurfaceProps = ToastSlotProps & SurfacePersonalizationProps;

export function ToastSurface({
  userId,
  personalization,
  personalizationRefreshKey,
  ...props
}: ToastSurfaceProps) {
  const content = useResolvedSurfaceContent(props.content, {
    userId,
    personalization,
    personalizationRefreshKey,
  });
  return <ToastSlot {...props} content={content} />;
}
