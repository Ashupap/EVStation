import crypto from 'node:crypto';
import type {
  CsmsAdapter,
  CsmsHealth,
  StationRegistrationInput,
  StationRegistrationResult,
  StationStatus,
} from './types.js';
import { CsmsError } from './types.js';

export class FakeCsmsAdapter implements CsmsAdapter {
  private readonly stations = new Map<string, { id: number; input: StationRegistrationInput }>();
  private nextId = 1;

  async registerStation(input: StationRegistrationInput): Promise<StationRegistrationResult> {
    const existing = this.stations.get(input.stationRef);
    if (existing && existing.input.stationId !== input.stationId) {
      throw new CsmsError('fake station conflict', 'CSMS_CONFLICT');
    }
    const id = existing?.id ?? this.nextId++;
    this.stations.set(input.stationRef, { id, input });
    return { csmsStationId: id, csmsLocationId: input.csmsLocationId ?? 1 };
  }

  async provisionPassword(): Promise<string> {
    return `fake-${crypto.randomBytes(8).toString('hex')}`;
  }

  async rotatePassword(): Promise<string> {
    return `rotated-${crypto.randomBytes(8).toString('hex')}`;
  }

  async getStationStatus(stationRef: string): Promise<StationStatus | null> {
    const station = this.stations.get(stationRef);
    return station
      ? { id: station.id, stationRef, online: false, protocol: 'ocpp1.6', lastConnectedAt: null }
      : null;
  }

  async listStations(): Promise<StationStatus[]> {
    return [...this.stations.entries()].map(([stationRef, station]) => ({
      id: station.id,
      stationRef,
      online: false,
      protocol: 'ocpp1.6',
      lastConnectedAt: null,
    }));
  }

  async sendCommand(): Promise<never> {
    throw new CsmsError('remote commands are Phase 4', 'CSMS_NOT_IMPLEMENTED');
  }

  async subscribeEvents(): Promise<{ close(): Promise<void> }> {
    return { close: async () => undefined };
  }

  async health(): Promise<CsmsHealth> {
    return { rest: true, hasura: true };
  }
}

export function createFakeCsmsAdapter(): CsmsAdapter {
  return new FakeCsmsAdapter();
}
