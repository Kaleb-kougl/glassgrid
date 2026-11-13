import { Component, type ErrorInfo, type ReactNode } from 'react';

/*
 * An error boundary for map views (docs/live-flights-l3-data.md): the map is
 * a third-party WebGL component in a lazy chunk, and nothing it throws
 * (rendering, in an effect, or while it is torn down) may take the rest of
 * the app with it. React hands an error to the nearest boundary that stays
 * mounted, so the app uses two: one inside each card around the component
 * (render and effect errors: the card says so and can restart its map), and
 * one around all the map cards (errors while a card is removed, when its own
 * boundary is going too).
 */

export interface MapBoundaryProps {
  children: ReactNode;
  /** What to show instead; `retry` renders the children again. */
  fallback: (error: Error, retry: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class MapBoundary extends Component<MapBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn('[glassgrid] map: the map view failed.', error, info.componentStack);
  }

  private readonly retry = () => this.setState({ error: null });

  override render(): ReactNode {
    return this.state.error === null ? this.props.children : this.props.fallback(this.state.error, this.retry);
  }
}
