import { Check } from 'lucide-react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

interface CheckboxProps {
  checked?: boolean;
  /** Called with the new boolean value when the checkbox is toggled */
  onChange?: (checked: boolean) => void;
  /** @deprecated use onChange — kept for shadcn compat */
  onCheckedChange?: (checked: boolean) => void;
  label?: string;
  description?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
  children?: React.ReactNode;
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  (
    {
      checked,
      onChange,
      onCheckedChange,
      label,
      description,
      className,
      id,
      disabled = false,
      children,
    },
    ref,
  ) => {
    const handleClick = () => {
      if (disabled) return;
      const next = !checked;
      onChange?.(next);
      onCheckedChange?.(next);
    };

    return (
      <button
        ref={ref}
        id={id}
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={handleClick}
        className={cn(
          'flex items-center gap-2.5 text-left group',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
          className,
        )}
      >
        {/* Checkbox box */}
        <span
          className={cn(
            'flex items-center justify-center w-4 h-4 rounded-md border shrink-0',
            'transition-all duration-150 ease-in-out',
            checked
              ? 'bg-teal-500 border-teal-500'
              : 'bg-zinc-800/50 border-zinc-700 group-hover:border-zinc-600',
            !disabled &&
              'group-focus-visible:ring-2 group-focus-visible:ring-teal-500/40 group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-gray-900',
          )}
        >
          {checked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
        </span>

        {/* Label + description */}
        {(label || children) && (
          <span className="flex flex-col min-w-0">
            {label && (
              <span className="text-sm text-zinc-300 leading-tight">{label}</span>
            )}
            {children}
            {description && (
              <span className="text-xs text-zinc-500 leading-tight">{description}</span>
            )}
          </span>
        )}
      </button>
    );
  },
);
Checkbox.displayName = 'Checkbox';

export default Checkbox;
