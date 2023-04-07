/**
 * @author Reinier van der Leer (Pwuts) <github@pwuts.nl>
 */

export type QToken = number;

export default class Queue {
  private nextToken = 0;
  private current?: QToken;
  private queue: { resolve: (t: QToken) => void, timeout?: number }[] = [];
  private timeoutHandle?: number;

  constructor(
    private defaultTimeout = 5000,
  ) {}

  async waitTurn(options?: { token?: QToken, turnTimeout?: number }): Promise<QToken> {
    if (this.current == undefined) {
      this.current = this.getToken();
      this.resetTimeout(options?.turnTimeout);
      return this.current;
    }
    else if (options?.token == this.current) {
      this.resetTimeout(options?.turnTimeout);
      return options.token;
    }
    return new Promise<QToken>((resolve) =>
      this.queue.push({ resolve, timeout: options?.turnTimeout })
    );
  }

  release(token: QToken) {
    if (token == this.current) {
      const p = this.queue.shift();
      if (p) {
        p.resolve(this.current = this.getToken());
        this.resetTimeout(p.timeout);
      } else {
        delete this.current;
        this.clearTimeout();
      }
    }
  }

  private getToken() {
    return this.nextToken++;
  }

  private clearTimeout() {
    clearTimeout(this.timeoutHandle);
  }

  private resetTimeout(timeout = this.defaultTimeout) {
    this.clearTimeout();
    this.timeoutHandle = setTimeout(
      (token: QToken) => {
        this.release(token);
        console.warn(`Queue: releasing token ${token} after ${timeout} ms`);
      },
      timeout,
      this.current,
    );
  }

  get length(): number {
    return this.queue.length;
  }
}
