import React from 'react';

/**
 * TBC brand logo (gold swirl).
 * Renders the brand image in a rounded container so it cleanly replaces
 * the previous Cpu icon throughout the app.
 */
export default function Logo({ size = 36, className = '', rounded = 'rounded-lg' }) {
  return (
    <div
      className={`relative grid place-items-center overflow-hidden ${rounded} bg-ink-950 ring-1 ring-tbc-500/30 ${className}`}
      style={{ width: size, height: size }}
    >
      <img
        src="/brand/logo.jpg"
        alt="TBC AI Tools"
        loading="eager"
        decoding="async"
        className="h-full w-full object-cover"
        draggable={false}
      />
    </div>
  );
}
