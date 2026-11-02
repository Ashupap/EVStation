import { describe, expect, it } from 'vitest';
import { DATABASE_NAME } from '../src/index.js';

describe('packages/db placeholder', () => {
  it('declares the database name', () => {
    expect(DATABASE_NAME).toBe('evstation');
  });
});
