import { Component, type ReactNode } from 'react';

/** Keeps a decorative or optional part of a page from taking the whole page down if it ever throws. */
export class Guard extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn('A page section failed and was hidden:', error);
  }
  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
