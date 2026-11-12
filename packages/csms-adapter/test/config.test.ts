import { describe, expect, it } from 'vitest';
import { loadCsmsAdapterConfig } from '../src/config.js';

const base = {
  CSMS_AUTH_MODE: 'jwt',
  CSMS_PROVISIONER_CLIENT_ID: 'csms-provisioner',
  CSMS_PROVISIONER_CLIENT_SECRET: 'secret',
  CSMS_READER_CLIENT_ID: 'csms-reader',
  CSMS_READER_CLIENT_SECRET: 'secret',
  CSMS_TENANT_ID: '1',
} as NodeJS.ProcessEnv;

describe('CSMS adapter configuration', () => {
  it('allows localDev only in development', () => {
    expect(() =>
      loadCsmsAdapterConfig({ ...base, CSMS_AUTH_MODE: 'localDev' }, 'production'),
    ).toThrow(/localDev.*development/u);
    expect(() => loadCsmsAdapterConfig({ ...base, CSMS_AUTH_MODE: 'localDev' }, 'test')).toThrow(
      /localDev.*development/u,
    );
    expect(
      loadCsmsAdapterConfig({ ...base, CSMS_AUTH_MODE: 'localDev' }, 'development').authMode,
    ).toBe('localDev');
  });

  it('requires jwt service credentials for non-local modes', () => {
    expect(() =>
      loadCsmsAdapterConfig({ ...base, CSMS_PROVISIONER_CLIENT_SECRET: '' }, 'production'),
    ).toThrow(/PROVISIONER_CLIENT_SECRET/u);
    expect(loadCsmsAdapterConfig(base, 'production').authMode).toBe('jwt');
  });
});
