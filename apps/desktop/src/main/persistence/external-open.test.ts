import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OpenRequestQueue, workspacePathsFromArgv } from './external-open';

describe('workspacePathsFromArgv', () => {
  it('picks .glassgrid paths, skipping the executable and flags, made absolute', () => {
    const cwd = resolve('/home/ada');
    expect(
      workspacePathsFromArgv(['/opt/Glassgrid/glassgrid', '--no-sandbox', 'work/a.glassgrid', resolve('/data/B.GLASSGRID'), 'notes.txt', '-psn_0_1'], cwd),
    ).toEqual([join(cwd, 'work', 'a.glassgrid'), resolve('/data/B.GLASSGRID')]);
    expect(workspacePathsFromArgv(['electron', '.'], cwd)).toEqual([]);
  });
});

describe('OpenRequestQueue', () => {
  it('queues requests until a window listens, then pushes to the preferred listener', () => {
    let focused: number | null = null;
    const queue = new OpenRequestQueue(() => focused);
    const a = { token: 'ot_aaaaaaaa', fileName: 'a.glassgrid' };
    const b = { token: 'ot_bbbbbbbb', fileName: 'b.glassgrid' };
    queue.push(a);
    const first = { key: 1, send: vi.fn() };
    const second = { key: 2, send: vi.fn() };
    expect(queue.listen(first)).toEqual([a]);
    expect(queue.listen(second)).toEqual([]);
    queue.push(b);
    expect(first.send).toHaveBeenCalledWith(b);
    focused = 2;
    queue.push(a);
    expect(second.send).toHaveBeenCalledWith(a);
    queue.remove(1);
    queue.remove(2);
    queue.push(b);
    expect(queue.listen(first)).toEqual([b]);
  });
});
