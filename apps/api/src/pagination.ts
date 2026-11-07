import { z } from 'zod';
import { AppError } from './errors.js';

export const PaginationQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export function encodeCursor(values: string[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, size: number): string[] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== size ||
      parsed.some((value) => typeof value !== 'string')
    ) {
      throw new Error('invalid cursor shape');
    }
    return parsed;
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'cursor is invalid');
  }
}

export function page<T>(
  rows: T[],
  limit: number,
  cursorValues: (row: T) => string[],
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(cursorValues(last)) : null,
  };
}
