import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const overlayPath = resolve(here, '../../../infra/compose/hasura/evstation-adapter-metadata.json');

interface Permission {
  role: string;
  permission: {
    columns?: string[] | string;
    filter?: unknown;
    check?: unknown;
    allow_aggregations?: boolean;
  };
}

interface TableMetadata {
  table: { name: string };
  select_permissions?: Permission[];
  insert_permissions?: Permission[];
  update_permissions?: Permission[];
  delete_permissions?: Permission[];
}

interface Overlay {
  role: string;
  tables: Record<string, TableMetadata>;
}

function loadOverlay(): Overlay {
  if (!existsSync(overlayPath)) {
    throw new Error(`missing committed Hasura adapter metadata overlay: ${overlayPath}`);
  }
  return JSON.parse(readFileSync(overlayPath, 'utf8')) as Overlay;
}

function permissionsFor(table: TableMetadata, kind: 'select' | 'insert' | 'update' | 'delete') {
  return (
    table[
      `${kind}_permissions` as
        'select_permissions' | 'insert_permissions' | 'update_permissions' | 'delete_permissions'
    ] ?? []
  );
}

function rolePermission(table: TableMetadata, kind: 'select' | 'insert' | 'update') {
  return permissionsFor(table, kind).filter(
    (permission) => permission.role === 'evstation_adapter',
  );
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe('restricted Hasura role for CitrineOS provisioning', () => {
  const overlay = (() => {
    try {
      return loadOverlay();
    } catch {
      return undefined;
    }
  })();

  it('commits the adapter metadata overlay', () => {
    expect(overlay, `expected ${overlayPath}`).toBeDefined();
  });

  it('grants exactly the four provisioning tables and no delete permission', () => {
    const granted = new Set<string>();
    for (const [name, table] of Object.entries(overlay?.tables ?? {})) {
      for (const kind of ['select', 'insert', 'update', 'delete'] as const) {
        if (
          permissionsFor(table, kind).some((permission) => permission.role === 'evstation_adapter')
        ) {
          granted.add(name);
        }
      }
      expect(rolePermission(table, 'select')).toHaveLength(1);
      expect(rolePermission(table, 'insert')).toHaveLength(1);
      expect(rolePermission(table, 'update')).toHaveLength(1);
      expect(
        permissionsFor(table, 'delete').filter(
          (permission) => permission.role === 'evstation_adapter',
        ),
      ).toHaveLength(0);
    }
    expect([...granted].sort()).toEqual(['ChargingStations', 'Connectors', 'Evses', 'Locations']);
    expect(Object.keys(overlay?.tables ?? {})).not.toContain('VariableAttributes');
  });

  it('uses explicit column allow-lists, never wildcard columns', () => {
    for (const table of Object.values(overlay?.tables ?? {})) {
      for (const kind of ['select', 'insert', 'update'] as const) {
        for (const permission of rolePermission(table, kind)) {
          expect(permission.permission.columns).not.toBe('*');
          expect(Array.isArray(permission.permission.columns)).toBe(true);
        }
      }
    }
  });

  it('pins tenantId and a managed marker on ChargingStations writes', () => {
    const stations = overlay?.tables.ChargingStations;
    if (!stations) return;
    for (const kind of ['insert', 'update'] as const) {
      for (const permission of rolePermission(stations, kind)) {
        const check = serialized(permission.permission.check);
        expect(check).toContain('x-hasura-tenant-id');
        expect(check).toContain('evstation_managed');
        if (kind === 'update') {
          expect(serialized(permission.permission.filter)).toContain('evstation_managed');
        }
      }
    }
    for (const permission of rolePermission(stations, 'update')) {
      expect(permission.permission.columns).not.toContain('capabilities');
    }
  });

  it('requires the station marker when writing Evses and Connectors', () => {
    for (const name of ['Evses', 'Connectors']) {
      const table = overlay?.tables[name];
      if (!table) continue;
      for (const kind of ['insert', 'update'] as const) {
        for (const permission of rolePermission(table, kind)) {
          const check = serialized(permission.permission.check);
          expect(check).toContain('ChargingStation');
          expect(check).toContain('evstation_managed');
          if (kind === 'update') {
            expect(serialized(permission.permission.filter)).toContain('ChargingStation');
          }
        }
      }
    }
  });

  it('does not grant VariableAttributes, delete, or unrelated tables', () => {
    expect(overlay?.tables.VariableAttributes).toBeUndefined();
    expect(overlay?.tables.Tenants).toBeUndefined();
    expect(overlay?.tables.Transactions).toBeUndefined();
    for (const table of Object.values(overlay?.tables ?? {})) {
      expect(permissionsFor(table, 'delete')).toHaveLength(0);
    }
  });
});
