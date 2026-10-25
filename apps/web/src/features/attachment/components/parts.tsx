import { Button, cn, Tooltip } from '@cellhive/ui';
import { Upload } from 'lucide-react';
import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react';

import { inputAccept } from '../../../lib/attachments/checks';

/**
 * Small building blocks of the attachment screens (board S4): 28 px icon
 * actions (44 px to touch below 1024 px), the progress bar of an upload,
 * the drop zone with its hidden file input.
 */

export interface IconActionProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly tone?: 'default' | 'muted' | 'danger';
  readonly className?: string;
  readonly 'data-testid'?: string;
  /** Inside the lightbox (a modal dialog): no tooltip, which would render behind it. */
  readonly bare?: boolean;
}

export function IconAction({
  label,
  onClick,
  children,
  tone = 'default',
  className,
  'data-testid': testId,
  bare = false,
}: IconActionProps) {
  const button = (
    <Button
      variant="ghost"
      size={null}
      aria-label={label}
      data-testid={testId}
      className={cn(
        'relative size-7 rounded-md max-lg:size-11 [&_svg]:size-3.5',
        tone === 'muted' && 'text-fg-muted',
        tone === 'danger' && 'text-danger',
        className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </Button>
  );
  return bare ? button : <Tooltip content={label}>{button}</Tooltip>;
}

/** Progress of an upload, 0–1 (decorative: the text next to it says the numbers). */
export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('block h-1 rounded-full bg-line', className)}>
      <span
        className="block h-1 rounded-full bg-accent transition-[width] duration-150 motion-reduce:transition-none"
        style={{ width: `${String(Math.round(Math.min(1, Math.max(0, value)) * 100))}%` }}
      />
    </span>
  );
}

/** Whether a drag carries files (not text or a card being moved). */
export function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

export interface FilePickerProps {
  readonly accept: readonly string[] | null;
  readonly onFiles: (files: File[]) => void;
  /** `capture` of a phone camera ("Take photo", board "Tệp trên mobile"). */
  readonly capture?: boolean;
}

/** A hidden file input and a function that opens it (buttons elsewhere call it). */
export function useFilePicker({ accept, onFiles, capture = false }: FilePickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const element = (
    <input
      ref={input}
      type="file"
      multiple={!capture}
      hidden
      tabIndex={-1}
      accept={capture ? 'image/*' : inputAccept(accept)}
      {...(capture ? { capture: 'environment' as const } : {})}
      data-testid={capture ? 'attachment-camera-input' : 'attachment-file-input'}
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        // The same file can be picked again after a failure.
        event.target.value = '';
        if (files.length > 0) onFiles(files);
      }}
    />
  );
  return {
    element,
    open: () => {
      input.current?.click();
    },
  };
}

export interface DropZoneProps {
  readonly title: string;
  readonly helper: string;
  readonly accept: readonly string[] | null;
  readonly onFiles: (files: File[]) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * The drop zone (board S4): a dashed box that is also a button opening the
 * file picker (keyboard: Tab, Enter); files dragged over it tint it.
 */
export function DropZone({
  title,
  helper,
  accept,
  onFiles,
  disabled = false,
  className,
}: DropZoneProps) {
  const helperId = useId();
  const [over, setOver] = useState(false);
  const picker = useFilePicker({ accept, onFiles });
  return (
    <>
      {picker.element}
      <button
        type="button"
        disabled={disabled}
        aria-describedby={helperId}
        data-testid="attachment-drop-zone"
        onClick={picker.open}
        onDragOver={(event) => {
          if (disabled || !carriesFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }}
        onDragLeave={() => {
          setOver(false);
        }}
        onDrop={(event) => {
          if (disabled || !carriesFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setOver(false);
          onFiles(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-1.5 rounded-lg p-3 text-center',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          'disabled:cursor-not-allowed disabled:opacity-60',
          over
            ? 'border-2 border-dashed border-accent bg-accent-soft'
            : 'border border-dashed border-line-strong bg-canvas hover:border-accent',
          className,
        )}
      >
        <span className="flex items-center gap-2 text-body text-fg">
          <Upload aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
          {title}
        </span>
        <span id={helperId} className="text-label font-normal text-fg-muted">
          {helper}
        </span>
      </button>
    </>
  );
}
