/** A minimal typed event emitter (node:events is not available in a browser worker). */
export class Emitter<Events extends Record<string, unknown[]>> {
  private readonly listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as unknown as (...args: never[]) => void);
    return this;
  }

  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    this.listeners.get(event)?.delete(listener as unknown as (...args: never[]) => void);
    return this;
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of [...set]) (listener as unknown as (...args: Events[K]) => void)(...args);
    return true;
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
