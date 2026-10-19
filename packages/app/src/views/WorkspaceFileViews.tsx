import type { RecentWorkspace, RecoverySnapshotInfo } from '@glassgrid/core';
import { Button } from '@glassgrid/ui';
import type { LocatePrompt, MismatchNotice, ReplacePrompt } from '../workspace-files';
import { Dialog } from './Dialog';

/*
 * The workspace-file UI around the main screen: the save-before-replacing
 * prompt, the locate prompt (a workspace's data file was not found), the
 * fingerprint-mismatch banner, and the start screen's crash-recovery offer
 * and recent workspaces.
 */

const when = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

function formatWhen(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : when.format(time);
}

export interface LocateDataDialogProps {
  prompt: LocatePrompt;
  busy: boolean;
  onLocate: () => void;
  onCancel: () => void;
}

/** "Where is trips.csv?": the native picker (Locate…) or Cancel, which forgets the pending open. */
export function LocateDataDialog({ prompt, busy, onLocate, onCancel }: LocateDataDialogProps) {
  const owner = prompt.workspaceName ?? 'The unsaved workspace';
  return (
    <Dialog
      title={`Where is ${prompt.dataFileName}?`}
      role="alertdialog"
      onCancel={onCancel}
      testId="locate-data"
      actions={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="locate-data-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={onLocate} disabled={busy} data-autofocus="" data-testid="locate-data-pick">
            {busy ? 'Opening…' : `Locate ${prompt.dataFileName}…`}
          </Button>
        </>
      }
    >
      <p>
        {owner} uses <strong>{prompt.dataFileName}</strong>, which is no longer where it was saved or next to the workspace file. Locate the file to open
        the workspace with it.
      </p>
      {prompt.error !== null && (
        <p className="dialog__error" role="alert">
          {prompt.error}
        </p>
      )}
    </Dialog>
  );
}

export interface SaveBeforeReplaceDialogProps {
  prompt: ReplacePrompt;
  busy: boolean;
}

/**
 * "Save changes to trips.glassgrid?" before an open replaces unsaved work:
 * Save (Save As when untitled; the open goes ahead once saved), Don't save,
 * or Cancel (Escape), which keeps everything as it is.
 */
export function SaveBeforeReplaceDialog({ prompt, busy }: SaveBeforeReplaceDialogProps) {
  const what = prompt.workspaceName ?? `this workspace on ${prompt.dataFileName}`;
  return (
    <Dialog
      title={prompt.workspaceName ? `Save changes to ${prompt.workspaceName}?` : 'Save this workspace?'}
      role="alertdialog"
      onCancel={() => prompt.answer('cancel')}
      testId="save-before-replace"
      actions={
        <>
          <Button variant="ghost" onClick={() => prompt.answer('discard')} disabled={busy} data-testid="save-before-replace-discard">
            Don’t save
          </Button>
          <span className="dialog__actions-spacer" />
          <Button variant="secondary" onClick={() => prompt.answer('cancel')} data-testid="save-before-replace-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={() => prompt.answer('save')} disabled={busy} data-autofocus="" data-testid="save-before-replace-save">
            {prompt.workspaceName ? 'Save' : 'Save as…'}
          </Button>
        </>
      }
    >
      <p>
        Opening another file replaces <strong>{what}</strong>, which has unsaved changes. Undo can bring it back in this window, but the changes are not
        in any file until you save them.
      </p>
    </Dialog>
  );
}

export interface MismatchBannerProps {
  notice: MismatchNotice;
  busy: boolean;
  onLocate: () => void;
  onDismiss: () => void;
  /** A dialog is open. */
  inert?: boolean;
}

/** Non-blocking: the workspace is open over data that differs from what it was saved with. It takes its own row above the panels. */
export function MismatchBanner({ notice, busy, onLocate, onDismiss, inert = false }: MismatchBannerProps) {
  return (
    <div className="banner-slot" inert={inert}>
      <div className="banner banner--warning" role="alert" data-testid="data-mismatch">
        <span className="banner__icon" aria-hidden="true">
          !
        </span>
        <span className="banner__message">{notice.message}</span>
        {notice.relinkToken !== null && (
          <Button size="sm" variant="secondary" onClick={onLocate} disabled={busy} data-testid="data-mismatch-locate">
            Locate another file…
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={onDismiss} data-testid="data-mismatch-continue">
          Continue
        </Button>
      </div>
    </div>
  );
}

export interface RecoveryOffersProps {
  entries: readonly RecoverySnapshotInfo[];
  busy: boolean;
  onRestore: (id: string) => void;
  onDiscard: (id: string) => void;
}

/** Unsaved work an earlier session left (a crash, a hung window): Restore or Discard each. */
export function RecoveryOffers({ entries, busy, onRestore, onDiscard }: RecoveryOffersProps) {
  if (entries.length === 0) return null;
  return (
    <section className="banner banner--info recovery" role="status" aria-labelledby="recovery-title" data-testid="recovery">
      <h2 className="recovery__title" id="recovery-title">
        {entries.length === 1 ? 'Unsaved changes from your last session' : `Unsaved changes from ${entries.length} earlier sessions`}
      </h2>
      <ul className="recovery__list">
        {entries.map((entry) => {
          const name = entry.workspaceFile?.fileName ?? `Untitled (${entry.dataFileName})`;
          return (
            <li key={entry.id} className="recovery__item" data-testid="recovery-entry">
              <span className="recovery__name">
                <strong>{name}</strong>
                <span className="recovery__detail">
                  {entry.workspaceFile ? `${entry.dataFileName} · ` : ''}autosaved {formatWhen(entry.savedAt)}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => onDiscard(entry.id)} disabled={busy} aria-label={`Discard unsaved changes to ${name}`} data-testid="recovery-discard">
                Discard
              </Button>
              <Button size="sm" variant="primary" onClick={() => onRestore(entry.id)} disabled={busy} aria-label={`Restore unsaved changes to ${name}`} data-testid="recovery-restore">
                Restore
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface RecentWorkspacesProps {
  entries: readonly RecentWorkspace[];
  busy: boolean;
  onOpen: (id: string) => void;
}

/** The start screen's recent workspaces (`listRecent`), newest first. */
export function RecentWorkspaces({ entries, busy, onOpen }: RecentWorkspacesProps) {
  if (entries.length === 0) return null;
  return (
    <section className="recent" aria-labelledby="recent-title" data-testid="recent-workspaces">
      <h2 className="recent__title" id="recent-title">
        Recent workspaces
      </h2>
      <ul className="recent__list">
        {entries.slice(0, 5).map((entry) => (
          <li key={entry.id}>
            <button type="button" className="recent__item" onClick={() => onOpen(entry.id)} disabled={busy} title={entry.directory} data-testid="recent-workspace">
              <span className="recent__name">{entry.fileName}</span>
              <span className="recent__folder">{entry.directory}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
