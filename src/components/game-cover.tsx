"use client";

import Image from "next/image";
import { useState } from "react";

export function GameCover({ src, alt = "" }: { src: string | null; alt?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) {
    return <span className="cover-placeholder" aria-hidden="true" />;
  }

  return (
    <Image
      src={src}
      alt={alt}
      width={40}
      height={56}
      unoptimized
      onError={() => setFailedSrc(src)}
    />
  );
}
