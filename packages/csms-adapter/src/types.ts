export interface StationRegistrationInput {
  stationId: string;
  tenantId: string;
  siteId: string;
  stationRef: string;
  orgCode: string;
  siteCode: string;
  csmsLocationId?: number | null;
  latitude?: number;
  longitude?: number;
  vendor?: string | null;
  model?: string | null;
  serial?: string | null;
  firmwareVersion?: string | null;
  ocppVersion?: 'ocpp1.6';
  connectors?: Array<{ connectorNumber: number; type?: string | null; maxPowerW?: number | null }>;
}

export interface StationRegistrationResult {
  csmsStationId: number;
  csmsLocationId: number;
}

export interface StationStatus {
  id: number;
  stationRef: string;
  online: boolean;
  protocol: string | null;
  lastConnectedAt: string | null;
}

export interface CsmsHealth {
  rest: boolean;
  hasura: boolean;
}

export interface CsmsAdapter {
  registerStation(input: StationRegistrationInput): Promise<StationRegistrationResult>;
  provisionPassword(stationRef: string): Promise<string>;
  rotatePassword(stationRef: string): Promise<string>;
  getStationStatus(stationRef: string): Promise<StationStatus | null>;
  listStations(): Promise<StationStatus[]>;
  sendCommand(stationRef: string, command: string, params: unknown): Promise<never>;
  subscribeEvents(handler: (event: unknown) => Promise<void>): Promise<{ close(): Promise<void> }>;
  health(): Promise<CsmsHealth>;
}

export class CsmsError extends Error {
  constructor(
    message: string,
    readonly code: 'CSMS_UNAVAILABLE' | 'CSMS_CONFLICT' | 'CSMS_AUTH' | 'CSMS_NOT_IMPLEMENTED',
  ) {
    super(message);
    this.name = 'CsmsError';
  }
}
