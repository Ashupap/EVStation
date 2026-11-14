import { describe, expect, it } from 'vitest';
import { SseStream } from './sse-helpers.js';

function frame(id: string, timestamp: string): Uint8Array {
  return new TextEncoder().encode(
    `id: ${id}\nevent: station.status\ndata: ${JSON.stringify({ csms_timestamp: timestamp })}\n\n`,
  );
}

describe('SseStream progress-aware waiting', () => {
  it('fails when no event arrives within the stall window', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        /* never emits */
      },
    });
    const sse = new SseStream(stream.getReader(), new AbortController());
    const started = Date.now();

    await expect(
      sse.waitForCountWithProgress('station.status', 5, { stallMs: 1_500, overallMs: 30_000 }),
    ).rejects.toThrow(/stalled waiting for 5 station.status/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('fails when the stream closes before the expected count', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame('1', '2026-01-01T00:00:00.000Z'));
        setTimeout(() => controller.close(), 200);
      },
    });
    const sse = new SseStream(stream.getReader(), new AbortController());

    await expect(
      sse.waitForCountWithProgress('station.status', 5, { stallMs: 5_000, overallMs: 30_000 }),
    ).rejects.toThrow(/stream closed after 1\/5/);
  });

  it('returns as soon as the expected count arrives', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 1; index <= 3; index += 1) {
          controller.enqueue(frame(String(index), `2026-01-01T00:00:0${index}.000Z`));
        }
      },
    });
    const sse = new SseStream(stream.getReader(), new AbortController());

    const frames = await sse.waitForCountWithProgress('station.status', 3, {
      stallMs: 5_000,
      overallMs: 30_000,
    });
    expect(frames).toHaveLength(3);
  });
});
