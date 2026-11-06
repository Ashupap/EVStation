import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('tenant context writes', () => {
  it('uses set_config only in the request-context module, always transaction-local', () => {
    const matches = sourceFiles(join(import.meta.dirname, '..', 'src')).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return source
        .split('\n')
        .map((line, index) => ({ file, line: line.trim(), number: index + 1 }))
        .filter((entry) => entry.line.includes('set_config('));
    });

    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.file.endsWith('/context.ts'), `${match.file}:${match.number}`).toBe(true);
      expect(match.line, `${match.file}:${match.number}`).toMatch(/, true\)/);
    }
  });
});

describe('database role URLs', () => {
  const base = {
    DATABASE_URL_APP: 'postgres://evstation_app:pw@localhost:5432/evstation',
    OIDC_ISSUER: 'http://localhost:8180/realms/evstation',
  };

  it('rejects DATABASE_URL_OWNER because the API runtime must never use it', () => {
    expect(() =>
      loadConfig({
        ...base,
        DATABASE_URL_OWNER: 'postgres://evstation_owner:pw@localhost:5432/evstation',
      }),
    ).toThrow(/DATABASE_URL_OWNER/);
  });

  it('rejects DATABASE_URL_MIGRATOR because the API runtime must never use it', () => {
    expect(() =>
      loadConfig({
        ...base,
        DATABASE_URL_MIGRATOR: 'postgres://evstation:pw@localhost:5432/evstation',
      }),
    ).toThrow(/DATABASE_URL_MIGRATOR/);
  });

  it('accepts runtime configuration without owner or migrator URLs', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv)).toMatchObject({
      databaseUrlApp: base.DATABASE_URL_APP,
    });
  });

  it('does not advertise owner or migrator URLs in .env.example', () => {
    const content = readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8');
    expect(content).not.toContain('DATABASE_URL_OWNER');
    expect(content).not.toContain('DATABASE_URL_MIGRATOR');
  });
});
