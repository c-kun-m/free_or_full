import { Worker } from 'node:worker_threads';
export class Store {
  private worker: Worker;
  private next = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  constructor(path: string) {
    this.worker = new Worker(new URL('./db-worker.mjs', import.meta.url), { workerData: { path } });
    this.worker.on('message', message => {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.result);
    });
    const fail = (error: Error) => {
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', () => fail(new Error('Storage worker stopped')));
  }
  call<T = any>(op: string, args: unknown = {}): Promise<T> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args });
    });
  }
  async close() {
    await this.call('close');
    await this.worker.terminate();
  }
}
