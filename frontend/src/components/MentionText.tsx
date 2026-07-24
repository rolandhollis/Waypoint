import { parseMentions, type MentionSegment } from "../lib/mentions";

/**
 * Render a plain-text body (comment or description) with any
 * `@[Name](user:UUID)` tokens replaced by a styled chip. Everything
 * else — literal `@` characters, code snippets, URLs — passes
 * through unchanged, so nothing about the underlying text is lost
 * on copy / hover / accessibility trees. See `frontend/src/lib/
 * mentions.ts` for the parser.
 *
 * `title={displayName}` on the chip surfaces the tagged user on
 * hover; adding an aria-label mirrors that for screen readers.
 */
export function MentionText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const segments = parseMentions(text);
  if (segments.length === 0) return null;
  return (
    <span className={className}>
      {segments.map((seg, i) => (
        <MentionSegmentSpan key={i} segment={seg} />
      ))}
    </span>
  );
}

function MentionSegmentSpan({ segment }: { segment: MentionSegment }) {
  if (segment.kind === "text") {
    return <>{segment.text}</>;
  }
  return (
    <span
      className="rounded-sm px-0.5 font-medium text-wp-red hover:underline"
      title={segment.displayName}
      aria-label={`Mention: ${segment.displayName}`}
    >
      @{segment.displayName}
    </span>
  );
}
