import { useRef, useState } from 'react';
import { formatBytes, type UndoEntry, type WorkspaceState } from '@glassgrid/core';
import { AgentIndicator, Button, HistoryItem, Popover, ProgressBar } from '@glassgrid/ui';
import { describeEntry } from '../describe';

export interface TopBarProps {
  platform: string;
  state: WorkspaceState;
  history: { readonly past: readonly UndoEntry[]; readonly future: readonly UndoEntry[] };
  opening: boolean;
  /** Background Parquet conversion of the open file (0..1, null = unknown), or absent. */
  optimizing: { fraction: number | null } | null;
  onOpen: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Step through history until `entryId` is the latest applied change. */
  onStepTo: (entryId: string) => void;
}

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * The 44px title bar: traffic-light inset on macOS, file name and size,
 * "Optimizing file" progress, Open file, Undo/Redo, History and the agent
 * indicator (a v1 placeholder).
 */
export function TopBar({ platform, state, history, opening, optimizing, onOpen, onUndo, onRedo, onStepTo }: TopBarProps) {
  const mod = platform === 'darwin' ? '⌘' : 'Ctrl+';
  const historyRef = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const count = history.past.length + history.future.length;
  const current = history.past.at(-1);

  return (
    <header className="topbar" data-testid="topbar">
      {platform === 'darwin' && <div className="topbar__inset" aria-hidden="true" />}
      {state.dataSource ? (
        <div className="topbar__file">
          <h1 className="topbar__name" data-testid="file-name">
            {state.dataSource.fileName}
          </h1>
          <span className="topbar__size">{formatBytes(state.dataSource.fingerprint.sizeBytes)}</span>
        </div>
      ) : (
        <span className="topbar__empty">No file open</span>
      )}
      {optimizing && (
        <ProgressBar
          variant="titlebar"
          className="topbar__progress"
          label="Optimizing file"
          value={optimizing.fraction}
          title="Building a columnar copy for fast queries. You can keep working."
        />
      )}
      <div className="topbar__spacer" />
      <div className="topbar__actions">
        <Button variant="secondary" onClick={onOpen} disabled={opening} data-testid="open-csv" title={`Open a CSV file ${mod}O`}>
          {opening ? 'Opening…' : 'Open file'}
        </Button>
        <div className="topbar__sep" aria-hidden="true" />
        <Button variant="icon" label="Undo" shortcut={`${mod}Z`} onClick={onUndo} disabled={history.past.length === 0} data-testid="undo">
          ↶
        </Button>
        <Button
          variant="icon"
          label="Redo"
          shortcut={platform === 'darwin' ? '⇧⌘Z' : 'Ctrl+Shift+Z'}
          onClick={onRedo}
          disabled={history.future.length === 0}
          data-testid="redo"
        >
          ↷
        </Button>
        <Button
          ref={historyRef}
          variant="ghost"
          onClick={() => setHistoryOpen((open) => !open)}
          disabled={count === 0}
          aria-haspopup="dialog"
          aria-expanded={historyOpen}
          data-testid="history-button"
        >
          History
          {count > 0 && <span className="gg-button__detail">{count}</span>}
        </Button>
        <Popover anchorRef={historyRef} open={historyOpen} onClose={() => setHistoryOpen(false)} placement="bottom-end" role="dialog" aria-label="History">
          <ol className="gg-history history-list" data-testid="history">
            {[...history.future].reverse().map((entry) => (
              <HistoryItem
                key={entry.id}
                label={describeEntry(entry, state)}
                caller={entry.caller}
                time={time.format(entry.at)}
                state="undone"
                onSelect={() => onStepTo(entry.id)}
                testId="history-entry"
              />
            ))}
            {[...history.past].reverse().map((entry) => (
              <HistoryItem
                key={entry.id}
                label={describeEntry(entry, state)}
                caller={entry.caller}
                time={time.format(entry.at)}
                state={entry === current ? 'current' : 'applied'}
                onSelect={() => onStepTo(entry.id)}
                testId="history-entry"
              />
            ))}
          </ol>
        </Popover>
        <div className="topbar__sep" aria-hidden="true" />
        <AgentIndicator status="off" />
      </div>
    </header>
  );
}
