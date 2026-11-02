import { describe, expect, it } from 'vitest';
import { ADAPTER_NAME } from '../src/index.js';

describe('packages/csms-adapter placeholder', () => {
  it('exports its package name', () => {
    expect(ADAPTER_NAME).toBe('evstation-csms-adapter');
  });
});
