interface BaseCardProps {
  /** Tailwind class for the 2px top accent bar (e.g. "bg-violet-500"). Omit to hide the bar. */
  accentColor?: string;
  /** Inline style for the accent bar — use for dynamic hex colors (overrides accentColor bg) */
  accentStyle?: React.CSSProperties;
  /** Click handler — also sets cursor-pointer on the card */
  onClick?: () => void;
  /** Rendered inside the stop-propagation footer area */
  footer?: React.ReactNode;
  /** Extra classes for the footer wrapper (default: "flex gap-2") */
  footerClassName?: string;
  children: React.ReactNode;
  /** Extra classes appended to the card wrapper */
  className?: string;
}

/**
 * Shared card shell used across Agents, Nodes, Plugins, Skills, Projects, Workflows,
 * Templates, Instances and Integrations.
 *
 * Provides:
 * - Consistent border / bg / hover styles
 * - Optional 2px top accent bar
 * - Optional stop-propagation footer slot
 *
 * Content sections (header + body with flex-1) are passed as children.
 */
export function BaseCard({
  accentColor,
  accentStyle,
  onClick,
  footer,
  footerClassName = 'flex gap-2',
  children,
  className,
}: BaseCardProps) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/50 hover:border-zinc-700 transition-all duration-200 flex flex-col${onClick ? ' cursor-pointer' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
    >
      {(accentColor || accentStyle) && (
        <div
          className={`absolute top-0 left-0 right-0 h-[2px]${accentColor ? ` ${accentColor}` : ''}`}
          style={accentStyle}
        />
      )}
      {children}
      {footer && (
        <div
          className={`border-t border-zinc-800/50 px-5 py-3 ${footerClassName}`}
          onClick={(e) => e.stopPropagation()}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
