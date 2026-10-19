/**
 * Checks every relative link and image in the README and the case study:
 * the file exists, and a `#fragment` names a heading in the target Markdown
 * file (GitHub's anchor rules). External URLs are not fetched.
 *
 *   node tools/showcase/src/check-links.ts [file.md ...]   # default: README.md docs/case-study.md
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DEFAULT_FILES = ['README.md', 'docs/case-study.md'];

/** Markdown with fenced code blocks blanked out (links and headings in code do not count). */
function withoutCode(markdown: string): string {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line.replace(/`[^`]*`/g, '``');
    })
    .join('\n');
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, duplicates numbered. */
export function anchorsOf(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const text = (heading[1] ?? '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '');
    const base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function targetsOf(markdown: string): string[] {
  const text = withoutCode(markdown);
  const targets: string[] = [];
  // [text](target "title") and ![alt](target)
  for (const match of text.matchAll(/!?\[(?:[^\]]|\][^(])*?\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.push(match[1] ?? '');
  // [label]: target
  for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm)) targets.push(match[1] ?? '');
  // <img src>, <source src>, <video src|poster>, <a href>
  for (const match of text.matchAll(/<(?:img|source|video|a)\b[^>]*?\s(?:src|href|poster)="([^"]+)"/g)) targets.push(match[1] ?? '');
  return targets;
}

export function checkLinks(files: readonly string[] = DEFAULT_FILES): string[] {
  const problems: string[] = [];
  let checked = 0;
  for (const file of files) {
    const path = resolve(REPO_ROOT, file);
    if (!existsSync(path)) {
      problems.push(`${file}: file not found`);
      continue;
    }
    const markdown = readFileSync(path, 'utf8');
    for (const target of targetsOf(markdown)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:
      checked += 1;
      const [rawPath = '', fragment] = target.split('#', 2);
      const decoded = decodeURIComponent(rawPath);
      const resolved = decoded === '' ? path : decoded.startsWith('/') ? join(REPO_ROOT, decoded) : resolve(dirname(path), decoded);
      const shown = `${file}: ${target}`;
      if (!existsSync(resolved)) {
        problems.push(`${shown} → missing ${relative(REPO_ROOT, resolved)}`);
        continue;
      }
      if (fragment !== undefined && fragment !== '' && statSync(resolved).isFile() && resolved.endsWith('.md')) {
        if (!anchorsOf(readFileSync(resolved, 'utf8')).has(fragment.toLowerCase())) problems.push(`${shown} → no heading #${fragment} in ${relative(REPO_ROOT, resolved)}`);
      }
    }
  }
  console.info(`[links] ${checked} relative links and images checked in ${files.join(', ')}: ${problems.length === 0 ? 'all resolve' : `${problems.length} broken`}`);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkLinks(process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FILES);
  for (const problem of problems) console.error(`  ${problem}`);
  if (problems.length > 0) process.exitCode = 1;
}
