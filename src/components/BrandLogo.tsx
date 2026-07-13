/**
 * Artivio brand mark — an "A" built from three ascending signal bars inside a
 * rounded gradient tile: the command-center idea (signals → action) in a form
 * that reads at 16px and at 256px.
 */
export const BrandMark = ({ size = 32, className = '' }: { size?: number; className?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="artivio-g" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
        <stop stopColor="#6366F1" />
        <stop offset="0.55" stopColor="#8B5CF6" />
        <stop offset="1" stopColor="#D946EF" />
      </linearGradient>
    </defs>
    <rect width="48" height="48" rx="12" fill="url(#artivio-g)" />
    {/* ascending bars */}
    <rect x="11" y="27" width="5" height="10" rx="2.5" fill="white" fillOpacity="0.55" />
    <rect x="19.5" y="21" width="5" height="16" rx="2.5" fill="white" fillOpacity="0.8" />
    <rect x="28" y="14" width="5" height="23" rx="2.5" fill="white" />
    {/* the "A" apex — a spark above the tallest bar */}
    <circle cx="30.5" cy="9" r="2.6" fill="white" />
  </svg>
);

export const BrandLogo = ({
  size = 28,
  className = '',
  wordmarkClassName = '',
}: {
  size?: number;
  className?: string;
  wordmarkClassName?: string;
}) => (
  <span className={`inline-flex items-center gap-2 ${className}`}>
    <BrandMark size={size} />
    <span className={`text-lg font-bold tracking-tight ${wordmarkClassName}`}>Artivio</span>
  </span>
);
