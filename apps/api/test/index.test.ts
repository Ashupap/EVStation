import { describe, expect, it } from 'vitest';
import { SERVICE_NAME } from '../src/index.js';

describe('apps/api placeholder', () => {
  it('exports its service name', () => {
    expect(SERVICE_NAME).toBe('evstation-api');
  });
});
