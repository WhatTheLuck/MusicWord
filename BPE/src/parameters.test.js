import { describe, expect, it } from 'vitest';
import { createParameterFile, normalizeParameterFile } from './parameters';

const parameters = {
  tpb: 24,
  saturation: 8,
  metric: 'cosine',
  threshold: .94,
  weights: { pitch: 1, velocity: .7, duration: .85, prevDelta: .65, nextDelta: .65, prevPitchDelta: .8, nextPitchDelta: .8 },
};

describe('parameter files', () => {
  it('creates a canonical versioned parameter document', () => {
    const document = createParameterFile(parameters, '2026-09-10T00:00:00.000Z');
    expect(document).toEqual({ schemaVersion: 1, savedAt: '2026-09-10T00:00:00.000Z', parameters });
  });

  it('rejects values outside the controls supported by the interface', () => {
    expect(() => normalizeParameterFile({ schemaVersion: 1, parameters: { ...parameters, tpb: 3 } })).toThrow('全局 TPB');
    expect(() => normalizeParameterFile({ schemaVersion: 1, parameters: { ...parameters, metric: 'unknown' } })).toThrow('相似度方法');
    expect(() => normalizeParameterFile({ schemaVersion: 1, parameters: { ...parameters, weights: { ...parameters.weights, pitch: Infinity } } })).toThrow('pitch 权重');
  });
});
