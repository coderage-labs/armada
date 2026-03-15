/**
 * ResponsiveDialog — Dialog on desktop (≥768px), Drawer on mobile (<768px).
 * Exports aliased to match Dialog API so JSX needs no changes when switching imports.
 */
import * as React from 'react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from './drawer';

/* ── Root ──────────────────────────────────────────── */

interface ResponsiveDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}

function ResponsiveDialog({ open, onOpenChange, children }: ResponsiveDialogProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        {children}
      </Dialog>
    );
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      {children}
    </Drawer>
  );
}

/* ── Content ───────────────────────────────────────── */

type ResponsiveDialogContentProps = React.ComponentPropsWithoutRef<typeof DialogContent>;

function ResponsiveDialogContent({ children, className, ...props }: ResponsiveDialogContentProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  if (isDesktop) {
    return (
      <DialogContent className={className} {...props}>
        {children}
      </DialogContent>
    );
  }
  return (
    <DrawerContent className={className}>
      {children}
    </DrawerContent>
  );
}

/* ── Header ───────────────────────────────────────── */

function ResponsiveDialogHeader(props: React.HTMLAttributes<HTMLDivElement>) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  return isDesktop ? <DialogHeader {...props} /> : <DrawerHeader {...props} />;
}

/* ── Footer ───────────────────────────────────────── */

function ResponsiveDialogFooter(props: React.HTMLAttributes<HTMLDivElement>) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  return isDesktop ? <DialogFooter {...props} /> : <DrawerFooter {...props} />;
}

/* ── Title ────────────────────────────────────────── */

type ResponsiveDialogTitleProps = React.ComponentPropsWithoutRef<typeof DialogTitle>;

const ResponsiveDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogTitle>,
  ResponsiveDialogTitleProps
>((props, ref) => {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  if (isDesktop) return <DialogTitle ref={ref} {...props} />;
  return <DrawerTitle ref={ref} {...props} />;
});
ResponsiveDialogTitle.displayName = 'ResponsiveDialogTitle';

/* ── Description ──────────────────────────────────── */

type ResponsiveDialogDescriptionProps = React.ComponentPropsWithoutRef<typeof DialogDescription>;

const ResponsiveDialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogDescription>,
  ResponsiveDialogDescriptionProps
>((props, ref) => {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  if (isDesktop) return <DialogDescription ref={ref} {...props} />;
  return <DrawerDescription ref={ref} {...props} />;
});
ResponsiveDialogDescription.displayName = 'ResponsiveDialogDescription';

/* ── Exports ──────────────────────────────────────── */

export {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
};

// Convenience short-name aliases so consumers can import as:
//   import { Dialog, DialogContent, ... } from './ui/responsive-dialog'
// without needing explicit "as" aliases in the import statement.
export {
  ResponsiveDialog as Dialog,
  ResponsiveDialogContent as DialogContent,
  ResponsiveDialogDescription as DialogDescription,
  ResponsiveDialogFooter as DialogFooter,
  ResponsiveDialogHeader as DialogHeader,
  ResponsiveDialogTitle as DialogTitle,
};
