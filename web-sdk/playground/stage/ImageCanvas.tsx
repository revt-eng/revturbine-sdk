import type { GeneratedImage } from '../state/image-engine';

export interface ImageCanvasProps {
  images: GeneratedImage[];
  /**
   * Capability-tier flag. When true (free tier), outputs carry the Prism
   * watermark + a faint low-res look; on unlock the overlay fades away.
   */
  watermarked: boolean;
}

/** The studio output gallery, with the capability-tier watermark overlay. */
export function ImageCanvas({ images, watermarked }: ImageCanvasProps) {
  if (images.length === 0) {
    return (
      <div className="prism-canvas prism-canvas--empty">
        <span className="prism-canvas__hint">
          Click <strong>Generate</strong> to create an image.
        </span>
      </div>
    );
  }

  return (
    <div className="prism-canvas">
      {images.map((img) => (
        <figure key={img.id} className={`prism-tile${watermarked ? ' is-watermarked' : ''}`}>
          <img src={img.src} alt="Generated artwork" />
          {img.premium && <span className="prism-tile__badge">Premium</span>}
        </figure>
      ))}
    </div>
  );
}
