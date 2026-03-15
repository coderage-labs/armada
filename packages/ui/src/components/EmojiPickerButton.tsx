import { useState, useRef, useEffect } from 'react';
import EmojiPicker, { Theme, EmojiClickData } from 'emoji-picker-react';
import { Button } from './ui/button';

interface Props {
  value: string | null;
  onChange: (emoji: string | null) => void;
  placeholder?: string;
  size?: 'sm' | 'md';
}

export default function EmojiPickerButton({ value, onChange, placeholder = '📁', size = 'md' }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = (data: EmojiClickData) => {
    onChange(data.emoji);
    setOpen(false);
  };

  const sizeClasses = size === 'sm'
    ? 'w-8 h-8 text-base'
    : 'w-10 h-10 text-xl';

  return (
    <div className="relative" ref={ref}>
      <Button
        type="button"
        variant="secondary"
        onClick={() => setOpen(!open)}
        className={`${sizeClasses} p-0 rounded-lg`}
        title="Pick emoji"
      >
        {value || placeholder}
      </Button>
      {value && (
        <Button
          type="button"
          variant="destructive"
          size="icon"
          onClick={(e) => { e.stopPropagation(); onChange(null); }}
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full text-[8px] p-0"
          title="Clear"
        >✕</Button>
      )}
      {open && (
        <div className="fixed inset-0 z-[9999]" onClick={() => setOpen(false)}>
          <div
            className="absolute"
            style={{
              ...(ref.current && window.innerHeight - ref.current.getBoundingClientRect().bottom < 420
                ? { bottom: window.innerHeight - ref.current.getBoundingClientRect().top + 4 }
                : { top: ref.current ? ref.current.getBoundingClientRect().bottom + 4 : 0 }),
              left: ref.current ? Math.min(ref.current.getBoundingClientRect().left, window.innerWidth - 330) : 0,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <EmojiPicker
              theme={Theme.DARK}
              onEmojiClick={handleSelect}
              width={320}
              height={400}
              searchPlaceHolder="Search emoji…"
              previewConfig={{ showPreview: false }}
              style={{
                '--epr-bg-color': 'rgba(15, 15, 25, 0.95)',
                '--epr-category-label-bg-color': 'rgba(15, 15, 25, 0.95)',
                '--epr-hover-bg-color': 'rgba(255, 255, 255, 0.1)',
                '--epr-focus-bg-color': 'rgba(255, 255, 255, 0.1)',
                '--epr-search-input-bg-color': 'rgba(255, 255, 255, 0.05)',
                '--epr-search-input-bg-color-active': 'rgba(255, 255, 255, 0.1)',
                '--epr-text-color': 'rgba(255, 255, 255, 0.8)',
                '--epr-search-input-text-color': 'rgba(255, 255, 255, 0.8)',
                '--epr-category-icon-active-color': '#8b5cf6',
                '--epr-highlight-color': '#8b5cf6',
                '--epr-search-border-color': 'rgba(255, 255, 255, 0.1)',
                '--epr-border-color': 'rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(20px)',
                borderRadius: '12px',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              } as React.CSSProperties}
            />
          </div>
        </div>
      )}
    </div>
  );
}
