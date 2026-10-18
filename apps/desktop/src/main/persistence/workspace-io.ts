import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  MAX_WORKSPACE_FILE_BYTES,
  parseWorkspace,
  WORKSPACE_FILE_EXTENSION,
  type DataFoundBy,
  type DataReference,
  type Fingerprint,
  type FingerprintMismatch,
  type ParsedWorkspace,
  type WorkspaceFileInfo,
} from '@glassgrid/core';

/** Why a workspace file could not be read from disk (before parsing). */
export class WorkspaceIoError extends Error {
  override readonly name = 'WorkspaceIoError';
}

/** Reads and parses a workspace file. Throws `WorkspaceIoError` or core's `WorkspaceFileError`. */
export async function readWorkspaceFile(path: string): Promise<ParsedWorkspace> {
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new WorkspaceIoError(`${basename(path)} is not a file`);
    if (info.size > MAX_WORKSPACE_FILE_BYTES) {
      throw new WorkspaceIoError(`${basename(path)} is too large to be a Glassgrid workspace`);
    }
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof WorkspaceIoError) throw error;
    throw new WorkspaceIoError(`Could not read ${basename(path)}: ${describeIoError(error)}`);
  }
  return parseWorkspace(text);
}

export function describeIoError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  switch (code) {
    case 'ENOENT':
      return 'the file does not exist';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'ENOSPC':
      return 'the disk is full';
    case 'EROFS':
      return 'the disk is read-only';
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

/** What the renderer may know about a workspace file. */
export function workspaceFileInfo(path: string): WorkspaceFileInfo {
  return { fileName: basename(path), directory: dirname(path) };
}

/** `name.glassgrid` for a data file `name.csv` (or `name.csv.gz`). */
export function defaultWorkspaceName(dataPath: string): string {
  const base = basename(dataPath).replace(/\.gz$/i, '').replace(/\.[^.]+$/, '');
  return `${base.length > 0 ? base : 'Untitled'}.${WORKSPACE_FILE_EXTENSION}`;
}

/** Appends `.glassgrid` unless the name already ends with it (Linux save dialogs do not add it). */
export function withWorkspaceExtension(path: string): string {
  return path.toLowerCase().endsWith(`.${WORKSPACE_FILE_EXTENSION}`) ? path : `${path}.${WORKSPACE_FILE_EXTENSION}`;
}

/**
 * The data reference to save: the absolute path and the path relative to
 * the workspace file's folder, with forward slashes so the file works on
 * every OS. Null when there is no workspace file or no relative path (data
 * on another drive).
 */
export function dataReferencePaths(
  workspacePath: string | null,
  dataPath: string,
  path: { relative: typeof relative; isAbsolute: typeof isAbsolute; dirname: typeof dirname; sep: string } = { relative, isAbsolute, dirname, sep },
): { absolutePath: string; relativePath: string | null } {
  if (workspacePath === null) return { absolutePath: dataPath, relativePath: null };
  const rel = path.relative(path.dirname(workspacePath), dataPath);
  if (rel === '' || path.isAbsolute(rel)) return { absolutePath: dataPath, relativePath: null };
  return { absolutePath: dataPath, relativePath: rel.split(path.sep).join('/') };
}

/** Where to look for the data, in order: relative to the workspace file, then the saved absolute path. */
export function relinkCandidates(workspacePath: string | null, data: DataReference): { via: Exclude<DataFoundBy, 'located'>; path: string }[] {
  const candidates: { via: Exclude<DataFoundBy, 'located'>; path: string }[] = [];
  if (workspacePath !== null && data.relativePath !== null) {
    candidates.push({ via: 'relative', path: resolve(dirname(workspacePath), data.relativePath.split('/').join(sep)) });
  }
  if (isAbsolute(data.absolutePath)) candidates.push({ via: 'absolute', path: data.absolutePath });
  return candidates;
}

export async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the workspace's data file: the first candidate that is a regular
 * file with the saved file name. A crafted workspace therefore cannot make
 * the app open an arbitrary file on its own; anything else needs the
 * person to pick it in the locate dialog.
 */
export async function findDataFile(
  workspacePath: string | null,
  data: DataReference,
  isFile: (path: string) => Promise<boolean> = isRegularFile,
): Promise<{ via: Exclude<DataFoundBy, 'located'>; path: string } | null> {
  for (const candidate of relinkCandidates(workspacePath, data)) {
    if (basename(candidate.path) !== data.fileName) continue;
    if (await isFile(candidate.path)) return candidate;
  }
  return null;
}

/**
 * Modification times closer than this count as equal: copying a file
 * between file systems (FAT and zip archives keep 2 s, HFS+ 1 s, others
 * round sub-millisecond parts differently) shifts a preserved mtime slightly.
 */
export const MTIME_TOLERANCE_MS = 2_000;

/**
 * How `actual` differs from the saved fingerprint, or null when it matches.
 * The cache `key` is not compared (it also encodes the exact mtime); mtimes
 * within `MTIME_TOLERANCE_MS` match.
 */
export function compareFingerprints(expected: Fingerprint, actual: Fingerprint): FingerprintMismatch | null {
  const sizeBytes = expected.sizeBytes === actual.sizeBytes ? null : { expected: expected.sizeBytes, actual: actual.sizeBytes };
  const mtimeMs = Math.abs(expected.mtimeMs - actual.mtimeMs) < MTIME_TOLERANCE_MS ? null : { expected: expected.mtimeMs, actual: actual.mtimeMs };
  const contentChanged = expected.headTailSha256 !== actual.headTailSha256;
  return sizeBytes === null && mtimeMs === null && !contentChanged ? null : { sizeBytes, mtimeMs, contentChanged };
}
