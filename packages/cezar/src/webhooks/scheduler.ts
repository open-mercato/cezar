type Release = () => void;
interface Waiter { project: string; host: string; resolve(value: Release | undefined): void; signal?: AbortSignal; abort?: () => void }
/** Only concurrency keys and waiters live here; payloads and keys stay with project services. */
export class WebhookScheduler {
  private projects = new Set<string>();
  private hosts = new Set<string>();
  private waiting: Waiter[] = [];
  acquire(project: string, host: string, signal?: AbortSignal): Promise<Release | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const waiter: Waiter = { project, host, resolve, signal };
      waiter.abort = () => {
        this.waiting = this.waiting.filter(item => item !== waiter);
        resolve(undefined); this.drain();
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter); this.drain();
    });
  }
  private drain(): void {
    while (this.projects.size < 4) {
      const index = this.waiting.findIndex(waiter => !this.projects.has(waiter.project) && !this.hosts.has(waiter.host));
      if (index < 0) return;
      const waiter = this.waiting.splice(index, 1)[0]!;
      if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort);
      this.projects.add(waiter.project); this.hosts.add(waiter.host);
      let released = false;
      waiter.resolve(() => {
        if (released) return; released = true;
        this.projects.delete(waiter.project); this.hosts.delete(waiter.host); this.drain();
      });
    }
  }
}
