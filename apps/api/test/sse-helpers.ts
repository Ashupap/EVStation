export interface SseFrame {
  name: string;
  data: string;
  id?: string;
}

export class SseStream {
  private buffer = '';
  private readonly frames: SseFrame[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly controller: AbortController,
  ) {
    void this.pump();
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const index = this.buffer.indexOf('\n\n');
          if (index < 0) break;
          const block = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 2);
          if (block.startsWith(':') || block.trim() === '') continue;
          let name = 'message';
          let id: string | undefined;
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('id:')) id = line.slice(3).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          this.frames.push({ name, data: data.join('\n'), ...(id ? { id } : {}) });
          for (const wake of this.waiters.splice(0)) wake();
        }
      }
    } catch {
      // Aborted/cancelled reader; treat as closed.
    }
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  async waitForEvent(name: string, timeoutMs: number): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.frames.find((item) => item.name === name);
      if (frame) return frame;
      if (this.closed) throw new Error(`stream closed before ${name}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timeout waiting for ${name}`);
      await this.sleep(remaining);
    }
  }

  async waitForCount(name: string, count: number, timeoutMs: number): Promise<SseFrame[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const matching = this.frames.filter((item) => item.name === name);
      if (matching.length >= count) return matching;
      if (this.closed) throw new Error(`stream closed after ${matching.length}/${count}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timeout waiting for ${count} ${name}`);
      await this.sleep(remaining);
    }
  }

  /**
   * Waits for `count` frames of `name`, failing only when delivery stalls.
   *
   * The per-event cost of an SSE stream is a database re-read, so a fixed
   * wall-clock deadline fails on a loaded machine even when delivery is
   * healthy. This waits until `stallMs` passes with no new frame, and keeps
   * `overallMs` as a backstop so a stream that stops early still fails.
   */
  async waitForCountWithProgress(
    name: string,
    count: number,
    options: { stallMs: number; overallMs: number },
  ): Promise<SseFrame[]> {
    const overallDeadline = Date.now() + options.overallMs;
    let seen = 0;
    let lastProgressAt = Date.now();
    for (;;) {
      const matching = this.frames.filter((item) => item.name === name);
      if (matching.length >= count) return matching;
      if (this.closed) throw new Error(`stream closed after ${matching.length}/${count}`);
      if (matching.length > seen) {
        seen = matching.length;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt >= options.stallMs) {
        throw new Error(
          `stalled waiting for ${count} ${name}: ${matching.length} received, ` +
            `none for ${options.stallMs}ms`,
        );
      }
      const remaining = overallDeadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timeout waiting for ${count} ${name}: ${matching.length} received`);
      }
      await this.sleep(remaining);
    }
  }

  private sleep(remainingMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      setTimeout(resolve, Math.min(remainingMs, 100));
    });
  }

  count(name: string): number {
    return this.frames.filter((frame) => frame.name === name).length;
  }

  async waitForClose(timeoutMs: number): Promise<SseFrame> {
    return this.waitForEvent('closed', timeoutMs);
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.reader.cancel().catch(() => undefined);
  }
}
