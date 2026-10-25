import { Component, type ReactNode } from 'react';

interface WidgetBoundaryProps {
  /** Shown instead of the widget after a render error; `reset` tries again. */
  readonly fallback: (reset: () => void) => ReactNode;
  readonly children: ReactNode;
}

interface WidgetBoundaryState {
  readonly failed: boolean;
}

/**
 * Each widget has an error boundary of its own (FRONTEND §8.2): a widget
 * that fails to render shows its fallback, the rest of the dashboard
 * stays. Nothing is logged (no record data in the console, SPEC §1A).
 */
export class WidgetBoundary extends Component<WidgetBoundaryProps, WidgetBoundaryState> {
  override state: WidgetBoundaryState = { failed: false };

  static getDerivedStateFromError(): WidgetBoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return this.props.fallback(() => {
        this.setState({ failed: false });
      });
    }
    return this.props.children;
  }
}
