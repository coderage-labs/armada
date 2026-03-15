import { CardSkeleton } from '../ui/skeleton';

interface CardGridProps {
  /** Show loading skeletons instead of children */
  loading?: boolean;
  /** Number of skeleton cards to show while loading (default: 3) */
  skeletonCount?: number;
  children?: React.ReactNode;
  className?: string;
}

/**
 * Shared responsive 3-column card grid.
 * Handles the loading skeleton state and consistent responsive layout
 * used across Agents, Nodes, Plugins, Skills, Projects, Workflows, Templates, Instances and Integrations.
 */
export function CardGrid({ loading, skeletonCount = 3, children, className }: CardGridProps) {
  const gridClass = `grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-stretch${className ? ` ${className}` : ''}`;

  if (loading) {
    return (
      <div className={gridClass}>
        {Array.from({ length: skeletonCount }, (_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    );
  }

  return <div className={gridClass}>{children}</div>;
}
