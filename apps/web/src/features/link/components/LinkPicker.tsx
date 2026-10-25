import { useState } from 'react';

import { usePicker } from '../use-picker';

import { LinkPickerDialog } from './LinkPickerDialog';
import { LinkPickerPopover } from './LinkPickerPopover';
import { LinkPickerSheet } from './LinkPickerSheet';

import type { LinkPickerProps } from '../../../lib/links/picker';

export { LinkHoverCard } from './LinkHoverCard';

/**
 * The link picker (T413, BACKLOG S4 design decision #1), one component
 * for its three forms: phones → the full-screen sheet; a field of one
 * record opened from a cell → the popover under it ("Expand" and creating
 * a record with required fields go to the dialog); otherwise the dialog
 * that saves once. The chosen records go to `onCommit`; the caller writes
 * them (optimistic, undo, errors: FRONTEND §4.1).
 */
export function LinkPicker(props: LinkPickerProps) {
  const [expanded, setExpanded] = useState(false);
  const popover = !props.fullScreen && !props.options.allow_multiple && props.anchor !== null;
  const state = usePicker(props, { withRecent: !popover || expanded });
  if (props.fullScreen) return <LinkPickerSheet props={props} state={state} />;
  if (popover && !expanded && state.creating === null) {
    return (
      <LinkPickerPopover
        props={props}
        state={state}
        anchor={props.anchor}
        onExpand={() => {
          setExpanded(true);
        }}
      />
    );
  }
  return <LinkPickerDialog props={props} state={state} />;
}

export default LinkPicker;
