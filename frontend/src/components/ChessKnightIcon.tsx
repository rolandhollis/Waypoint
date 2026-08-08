/** Chess knight — used for the daily prediction game nav entry. */
export function ChessKnightIcon({
  size = 18,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M8 20h8" />
      <path d="M9 20v-2.5" />
      <path d="M15 20v-2.5" />
      <path d="M6.5 17.5h11" />
      <path d="M12 17.5V11" />
      <path d="M9.5 11c0-2.2 1.5-4 3.5-4.5 1.2-.3 2.2-1.1 2.5-2.3.3-1.5-.5-2.8-1.8-3.2-1.5-.5-3.1.2-3.8 1.5-.4.8-.5 1.7-.3 2.5" />
      <path d="M8.5 8.5c-.8 1.2-.5 2.8.8 3.5" />
    </svg>
  );
}
