'use client';

/**
 * The image pane. The browser is the renderer — every format served here is one it draws
 * natively, so the pane is a transform, not a decoder.
 */
export interface ImageViewerProps {
  readonly url: string;
  readonly alt: string;
  readonly zoom: number;
  readonly rotation: number;
  readonly onError: () => void;
}

export function ImageViewer({ url, alt, zoom, rotation, onError }: ImageViewerProps) {
  return (
    <div className="flex justify-center overflow-auto p-4">
      {/* A preview URL is short-lived and single-object; next/image's optimizer proxy would
          re-fetch it server-side after it expired. The raw tag is the correct client here. */}
      <img
        src={url}
        alt={alt}
        onError={onError}
        className="max-w-none shadow"
        style={{
          transform: `scale(${String(zoom)}) rotate(${String(rotation)}deg)`,
          transformOrigin: 'center',
        }}
      />
    </div>
  );
}
