import type { GeneratedImage } from '../state/image-engine';

export interface ImageCanvasProps {
  images: GeneratedImage[];
  /**
   * Capability-tier flag. When true (free tier), outputs carry the Prism
   * watermark + a faint low-res look; on unlock the overlay fades away.
   */
  watermarked: boolean;
  /**
   * Total images generated this period. The canvas only keeps the 24 most
   * recent tiles (a 3×8 grid); when more than that have been generated, an
   * "and N more" caption stands in for the rest (decorative — there is no
   * further gallery to page through).
   */
  totalGenerated: number;
}

/** The studio output gallery, with the capability-tier watermark overlay. */
export function ImageCanvas({ images, watermarked, totalGenerated }: ImageCanvasProps) {
  if (images.length === 0) {
    return (
      <div className="prism-canvas prism-canvas--empty">
        <span className="prism-canvas__hint">
          Click <strong>Generate</strong> to create an image.
        </span>
      </div>
    );
  }

  const moreCount = Math.max(0, totalGenerated - images.length);

  return (
    <div className="prism-canvas-wrap">
      <div className="prism-canvas">
        {images.map((img) => (
          <figure key={img.id} className={`prism-tile${watermarked ? ' is-watermarked' : ''}`}>
            <img src={img.src} alt="Generated artwork" />
            {img.premium && <span className="prism-tile__badge">Premium</span>}
          </figure>
        ))}
      </div>
      {moreCount > 0 && <p className="prism-canvas__more">…and {moreCount} more this month</p>}
    </div>
  );
}
