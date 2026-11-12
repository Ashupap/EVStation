export interface MeterSample {
  recorded_at: string;
  energy_wh: number | null;
  power_w: number | null;
}

function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function normalize(value: number, unit: string | null, target: 'energy' | 'power'): number {
  const normalizedUnit = (unit ?? (target === 'energy' ? 'Wh' : 'W')).toLowerCase();
  if (target === 'energy') {
    if (normalizedUnit === 'kwh') return Math.round(value * 1000);
    if (normalizedUnit === 'wh') return Math.round(value);
  } else {
    if (normalizedUnit === 'kw') return Math.round(value * 1000);
    if (normalizedUnit === 'w') return Math.round(value);
  }
  return Math.round(value);
}

export function normalizeMeterValues(
  payload: Record<string, unknown>,
  fallbackTimestamp: string,
  limit = 200,
): MeterSample[] {
  const meterValue = payload.meterValue;
  if (!Array.isArray(meterValue)) throw new Error('METER_VALUE_MISSING');
  return meterValue.slice(0, limit).map((rawElement) => {
    if (!rawElement || typeof rawElement !== 'object') throw new Error('METER_VALUE_INVALID');
    const element = rawElement as Record<string, unknown>;
    const timestamp = scalar(element.timestamp) ?? fallbackTimestamp;
    let energy: number | null = null;
    let power: number | null = null;
    const sampled = element.sampledValue;
    if (Array.isArray(sampled)) {
      for (const rawSample of sampled) {
        if (!rawSample || typeof rawSample !== 'object') continue;
        const sample = rawSample as Record<string, unknown>;
        const value = Number(scalar(sample.value));
        if (!Number.isFinite(value)) continue;
        const measurand = scalar(sample.measurand) ?? 'Energy.Active.Import.Register';
        const unit = scalar(sample.unit);
        if (energy === null && measurand === 'Energy.Active.Import.Register') {
          energy = normalize(value, unit, 'energy');
        }
        if (power === null && measurand === 'Power.Active.Import') {
          power = normalize(value, unit, 'power');
        }
      }
    }
    return { recorded_at: timestamp, energy_wh: energy, power_w: power };
  });
}
