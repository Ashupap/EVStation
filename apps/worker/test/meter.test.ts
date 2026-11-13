import { describe, expect, it } from 'vitest';
import { normalizeMeterValues } from '../src/meter.js';

describe('meter normalization', () => {
  it('normalizes kWh/kW and extracts the default energy measurand', () => {
    const values = normalizeMeterValues(
      {
        meterValue: [
          {
            timestamp: '2026-11-12T10:00:00Z',
            sampledValue: [
              { value: '1.5', unit: 'kWh' },
              { value: '7', unit: 'kW', measurand: 'Power.Active.Import' },
            ],
          },
        ],
      },
      '2026-11-12T11:00:00Z',
    );
    expect(values).toEqual([
      { recorded_at: '2026-11-12T10:00:00.000Z', energy_wh: 1500, power_w: 7000 },
    ]);
  });

  it('emits one row per meterValue element, keeps nulls, caps at 200, and falls back timestamps', () => {
    const meterValue = Array.from({ length: 205 }, (_, index) => ({
      ...(index === 1
        ? {}
        : { timestamp: `2026-11-12T10:00:${String(index % 60).padStart(2, '0')}Z` }),
      sampledValue: [{ value: String(index), unit: 'Wh' }],
    }));
    const values = normalizeMeterValues(
      { meterValue: [{}, { timestamp: '2026-11-12T10:00:01Z', sampledValue: [] }] },
      '2026-11-12T11:00:00Z',
    );
    expect(values).toEqual([
      { recorded_at: '2026-11-12T11:00:00Z', energy_wh: null, power_w: null },
      { recorded_at: '2026-11-12T10:00:01.000Z', energy_wh: null, power_w: null },
    ]);
    expect(normalizeMeterValues({ meterValue }, '2026-11-12T11:00:00Z')).toHaveLength(200);
  });

  it('skips unknown units, sums phase power and falls back invalid timestamps', () => {
    const values = normalizeMeterValues(
      {
        meterValue: [
          {
            timestamp: 'not-a-date',
            sampledValue: [
              { value: '1', unit: 'MWh', measurand: 'Energy.Active.Import.Register' },
              { value: '2', unit: 'kW', measurand: 'Power.Active.Import', phase: 'L1' },
              { value: '3', unit: 'kW', measurand: 'Power.Active.Import', phase: 'L2' },
            ],
          },
        ],
      },
      '2026-11-12T11:00:00Z',
    );
    expect(values).toEqual([
      { recorded_at: '2026-11-12T11:00:00Z', energy_wh: null, power_w: 5000 },
    ]);
  });

  it('rejects a missing meterValue array', () => {
    expect(() => normalizeMeterValues({}, '2026-11-12T11:00:00Z')).toThrow('METER_VALUE_MISSING');
  });
});
