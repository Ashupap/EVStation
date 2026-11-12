import { CsmsError } from './types.js';
import type { TokenProvider } from './token.js';
import { localDevToken } from './token.js';

export class CitrineRestClient {
  private localToken?: { value: string; expiresAt: number };
  constructor(
    private readonly baseUrl: string,
    private readonly authMode: 'localDev' | 'jwt',
    private readonly tenantId: number,
    private readonly token?: TokenProvider,
    private readonly timeoutMs = 10_000,
  ) {}

  private async tokenValue(): Promise<string | undefined> {
    if (this.authMode === 'jwt') return this.token?.get();
    if (this.localToken && this.localToken.expiresAt > Date.now()) return this.localToken.value;
    const value = await localDevToken(this.baseUrl, this.timeoutMs);
    this.localToken = { value, expiresAt: Date.now() + 30 * 60 * 1000 };
    return value;
  }

  async provisionPassword(
    stationRef: string,
    password: string,
    mutability: 'ReadWrite' | 'WriteOnly',
  ): Promise<void> {
    const token = await this.tokenValue();
    const response = await fetch(
      `${this.baseUrl}/commands/provisionStationVariables?tenantId=${this.tenantId}&ocppConnectionName=${encodeURIComponent(stationRef)}&setOnCharger=false`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          variableAttribute: [{ type: 'Actual', value: password, mutability }],
          variableCharacteristics: { dataType: 'passwordString', supportsMonitoring: false },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok)
      throw new CsmsError('CitrineOS password provisioning failed', 'CSMS_UNAVAILABLE');
  }
}
