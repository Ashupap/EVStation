import crypto from 'node:crypto';
import type {
  CsmsAdapter,
  CsmsHealth,
  StationRegistrationInput,
  StationRegistrationResult,
  StationStatus,
} from './types.js';
import { CsmsError } from './types.js';
import type { CsmsAdapterConfig } from './config.js';
import { HasuraClient } from './hasura.js';
import { CitrineRestClient } from './rest.js';
import { TokenProvider } from './token.js';

const PASSWORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function password(): string {
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += PASSWORD_CHARS[crypto.randomInt(PASSWORD_CHARS.length)];
  }
  return value;
}

export class CitrineOsAdapter implements CsmsAdapter {
  private readonly provisioner: HasuraClient;
  private readonly reader: HasuraClient;
  private readonly rest: CitrineRestClient;
  constructor(private readonly config: CsmsAdapterConfig) {
    this.provisioner = new HasuraClient(
      config.hasuraUrl,
      new TokenProvider(
        config.tokenUrl,
        config.provisionerClientId,
        config.provisionerClientSecret,
      ),
    );
    this.reader = new HasuraClient(
      config.hasuraUrl,
      new TokenProvider(config.tokenUrl, config.readerClientId, config.readerClientSecret),
    );
    this.rest = new CitrineRestClient(
      config.baseUrl,
      config.authMode,
      new TokenProvider(
        config.tokenUrl,
        config.provisionerClientId,
        config.provisionerClientSecret,
      ),
    );
  }

  async registerStation(input: StationRegistrationInput): Promise<StationRegistrationResult> {
    const existing = await this.reader.query<{
      ChargingStations: Array<{ id: number; capabilities?: { evstation_managed?: boolean } }>;
    }>(
      `query($name: String!) { ChargingStations(where: {ocppConnectionName: {_eq: $name}}, limit: 1) { id capabilities } }`,
      { name: input.stationRef },
    );
    if (existing.ChargingStations.length > 0) {
      const station = existing.ChargingStations[0];
      if (!station?.capabilities?.evstation_managed) {
        throw new CsmsError(
          'CitrineOS station already exists and is not EVStation-managed',
          'CSMS_CONFLICT',
        );
      }
      return {
        csmsStationId: station.id,
        csmsLocationId: input.csmsLocationId ?? 0,
      };
    }

    let locationId = input.csmsLocationId ?? null;
    if (!locationId) {
      const location = await this.provisioner.query<{ insert_Locations_one: { id: number } }>(
        `mutation($name: String!, $tenantId: Int!, $coordinates: geometry!, $now: timestamptz!) {
           insert_Locations_one(object: {name: $name, tenantId: $tenantId, coordinates: $coordinates, createdAt: $now, updatedAt: $now}) { id }
         }`,
        {
          name: `EVStation ${input.stationRef}`,
          tenantId: this.config.tenantId,
          coordinates: { type: 'Point', coordinates: [input.longitude ?? 0, input.latitude ?? 0] },
          now: new Date().toISOString(),
        },
      );
      locationId = location.insert_Locations_one.id;
    }

    const station = await this.provisioner.query<{ insert_ChargingStations_one: { id: number } }>(
      `mutation($name: String!, $locationId: Int!, $tenantId: Int!, $now: timestamptz!) {
         insert_ChargingStations_one(object: {
           ocppConnectionName: $name, locationId: $locationId, tenantId: $tenantId,
           protocol: "ocpp1.6", chargePointVendor: "EVStation", chargePointModel: "EVStation",
           createdAt: $now, updatedAt: $now
         }) { id }
       }`,
      {
        name: input.stationRef,
        locationId,
        tenantId: this.config.tenantId,
        now: new Date().toISOString(),
      },
    );
    const csmsStationId = station.insert_ChargingStations_one.id;
    const evse = await this.provisioner.query<{ insert_Evses_one: { id: number } }>(
      `mutation($stationId: Int!, $tenantId: Int!, $now: timestamptz!) {
         insert_Evses_one(object: {stationId: $stationId, tenantId: $tenantId, evseId: "1", createdAt: $now, updatedAt: $now}) { id }
       }`,
      { stationId: csmsStationId, tenantId: this.config.tenantId, now: new Date().toISOString() },
    );
    const connectors = input.connectors?.length ? input.connectors : [{ connectorNumber: 1 }];
    for (const connector of connectors) {
      await this.provisioner.query(
        `mutation($stationId: Int!, $evseId: Int!, $tenantId: Int!, $number: Int!, $now: timestamptz!) {
           insert_Connectors_one(object: {
             stationId: $stationId, evseId: $evseId, tenantId: $tenantId, connectorId: $number,
             status: "Available", errorCode: "NoError", createdAt: $now, updatedAt: $now
           }) { id }
         }`,
        {
          stationId: csmsStationId,
          evseId: evse.insert_Evses_one.id,
          tenantId: this.config.tenantId,
          number: connector.connectorNumber,
          now: new Date().toISOString(),
        },
      );
    }
    return { csmsStationId, csmsLocationId: locationId };
  }

  async provisionPassword(stationRef: string): Promise<string> {
    const value = password();
    await this.rest.provisionPassword(stationRef, value, 'WriteOnly');
    return value;
  }

  async rotatePassword(stationRef: string): Promise<string> {
    const value = password();
    await this.rest.provisionPassword(stationRef, value, 'ReadWrite');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.rest.provisionPassword(stationRef, value, 'WriteOnly');
        return value;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    throw new CsmsError('CitrineOS password rotation incomplete', 'CSMS_UNAVAILABLE');
  }

  async getStationStatus(stationRef: string): Promise<StationStatus | null> {
    const result = await this.reader.query<{
      ChargingStations: Array<{
        id: number;
        ocppConnectionName: string;
        isOnline: boolean | null;
        protocol: string | null;
        lastConnectedAt: string | null;
      }>;
    }>(
      `query($name: String!) { ChargingStations(where: {ocppConnectionName: {_eq: $name}}, limit: 1) { id ocppConnectionName isOnline protocol lastConnectedAt } }`,
      { name: stationRef },
    );
    const station = result.ChargingStations[0];
    return station
      ? {
          id: station.id,
          stationRef: station.ocppConnectionName,
          online: station.isOnline === true,
          protocol: station.protocol,
          lastConnectedAt: station.lastConnectedAt,
        }
      : null;
  }

  async listStations(): Promise<StationStatus[]> {
    const result = await this.reader.query<{
      ChargingStations: Array<{
        id: number;
        ocppConnectionName: string;
        isOnline: boolean | null;
        protocol: string | null;
        lastConnectedAt: string | null;
      }>;
    }>(
      `query { ChargingStations(order_by: {ocppConnectionName: asc}) { id ocppConnectionName isOnline protocol lastConnectedAt } }`,
    );
    return result.ChargingStations.map((station) => ({
      id: station.id,
      stationRef: station.ocppConnectionName,
      online: station.isOnline === true,
      protocol: station.protocol,
      lastConnectedAt: station.lastConnectedAt,
    }));
  }

  async sendCommand(): Promise<never> {
    throw new CsmsError('remote commands are Phase 4', 'CSMS_NOT_IMPLEMENTED');
  }

  async subscribeEvents(): Promise<{ close(): Promise<void> }> {
    throw new CsmsError('event ingestion lands in Phase 2b', 'CSMS_NOT_IMPLEMENTED');
  }

  async health(): Promise<CsmsHealth> {
    const [rest, hasura] = await Promise.allSettled([
      fetch(`${this.config.baseUrl}/health`),
      this.reader.query('query { __typename }'),
    ]);
    return {
      rest: rest.status === 'fulfilled' && rest.value.ok,
      hasura: hasura.status === 'fulfilled',
    };
  }
}

export function createCitrineOsAdapter(config: CsmsAdapterConfig): CsmsAdapter {
  return new CitrineOsAdapter(config);
}
