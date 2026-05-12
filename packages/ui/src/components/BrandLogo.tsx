import type { SVGProps } from "react";

interface BrandLogoProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
  size?: number;
}

export function BrandLogo({ size = 24, className, ...rest }: BrandLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Data View"
      className={className}
      {...rest}
    >
      <defs>
        <linearGradient id="dv-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6E5BFF" />
          <stop offset="100%" stopColor="#9B7EFF" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="64" height="64" rx="14" ry="14" fill="url(#dv-logo-bg)" />
      <g fill="#ffffff">
        <rect x="14" y="34" width="8" height="18" rx="3" />
        <rect x="26" y="24" width="8" height="28" rx="3" />
        <rect x="38" y="16" width="8" height="36" rx="3" />
        <circle cx="42" cy="11" r="5" />
      </g>
    </svg>
  );
}
