/**
 * Shared modal for viewing workflow step run details.
 * Uses Dialog with a slide-in side panel layout.
 */
import { X } from 'lucide-react';
import StepRunDetail from './StepRunDetail';
import type { StepRunData } from './StepRunDetail';
import { Button } from './ui/button';
import { Dialog, DialogPortal, DialogOverlay } from './ui/dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../lib/utils';

interface Props {
  step: StepRunData;
  onAction: () => void;
  onClose: () => void;
  showPrompt?: boolean;
}

export default function StepRunModal({ step, onAction, onClose, showPrompt }: Props) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 right-0 z-50 w-full sm:w-[520px]',
            'bg-zinc-900/95 border-l border-zinc-700 shadow-2xl',
            'flex flex-col',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
            'duration-300',
          )}
        >
          <div className="flex items-center justify-between p-4 border-b border-zinc-700">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-100">Step: {step.stepId}</h3>
              <span className="text-[10px] text-zinc-500">{step.role}</span>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X className="w-5 h-5" />
            </Button>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <StepRunDetail step={step} onAction={onAction} showPrompt={showPrompt} />
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
