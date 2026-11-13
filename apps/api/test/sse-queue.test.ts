import { describe, expect, it } from 'vitest';
import { OrderedReReadQueue } from '../src/sse.js';

describe('ordered bounded re-read queue', () => {
  it('preserves FIFO per station while allowing bounded concurrency', async () => {
    const seen: string[] = [];
    let active = 0;
    let maxActive = 0;
    const queue = new OrderedReReadQueue<{ key: string; id: number }>(
      async (item) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, item.id === 1 ? 50 : 5));
        seen.push(`${item.key}:${item.id}`);
        active -= 1;
      },
      (item) => item.key,
      2,
      2,
    );
    queue.push({ key: 'station-a', id: 1 });
    queue.push({ key: 'station-a', id: 2 });
    queue.push({ key: 'station-b', id: 3 });
    queue.push({ key: 'station-c', id: 4 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen.filter((value) => value.startsWith('station-a'))).toEqual([
      'station-a:1',
      'station-a:2',
    ]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('drops with a metric callback when the bounded queue is full', async () => {
    let drops = 0;
    const queue = new OrderedReReadQueue<number>(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      () => 'same',
      1,
      1,
      () => {
        drops += 1;
      },
    );
    queue.push(1);
    queue.push(2);
    queue.push(3);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(drops).toBe(1);
  });
});
