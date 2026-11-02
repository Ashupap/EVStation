import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('packages/shared placeholder', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('evstation-shared');
  });
});
