import { cx } from '../cx.js';

export interface AgentIndicatorProps {
  /**
   * `off`: v1 placeholder, no agent can connect yet (dashed, disabled look).
   * `connected` / `editing`: v2, an AI app is connected over MCP.
   */
  status: 'off' | 'connected' | 'editing';
}

/** Shows whether an AI app is connected (v2); a quiet placeholder in v1. */
export function AgentIndicator({ status }: AgentIndicatorProps) {
  if (status === 'off') {
    return (
      <div className={cx('gg-agent', 'gg-agent--off')} role="status" title="Agent connection (v2)" data-testid="agent-indicator">
        <span className="gg-agent__dot" aria-hidden="true" />
        <span className="gg-agent__name">Agent · not connected</span>
      </div>
    );
  }
  return (
    <div className="gg-agent" role="status" title="An AI app is connected over MCP" data-testid="agent-indicator">
      <span className="gg-agent__dot" aria-hidden="true" />
      <span className="gg-agent__name">Agent connected</span>
      {status === 'editing' && <span className="gg-agent__detail">· editing</span>}
    </div>
  );
}
