import { describe, expect, it } from 'vitest';
import { createSerialDispatcher } from '../src/events.js';

describe('AMQP serial dispatcher', () => {
  it('awaits handlers in order instead of processing concurrently', async () => {
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    const dispatch = createSerialDispatcher<number>(async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, value === 1 ? 30 : 1));
      order.push(value);
      active -= 1;
    });
    const first = dispatch(1);
    const second = dispatch(2);
    const third = dispatch(3);
    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
  });
});
