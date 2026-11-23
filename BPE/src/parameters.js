export const PARAMETER_FILENAME = 'bpe-parameters.json';

export const PARAMETER_FEATURE_KEYS = [
  'pitch', 'velocity', 'duration', 'prevDelta', 'nextDelta', 'prevPitchDelta', 'nextPitchDelta',
];

const METRICS = new Set(['cosine', 'euclidean', 'manhattan']);

function requireNumber(value, label, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} 必须是 ${min}–${max}${integer ? ' 之间的整数' : ' 之间的数字'}`);
  }
  return value;
}

export function normalizeParameterFile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数文件必须是 JSON 对象');
  if (input.schemaVersion !== 1) throw new Error('不支持的参数文件版本');
  const parameters = input.parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('参数文件缺少 parameters');
  if (!METRICS.has(parameters.metric)) throw new Error('相似度方法无效');
  if (!parameters.weights || typeof parameters.weights !== 'object' || Array.isArray(parameters.weights)) throw new Error('参数文件缺少特征权重');

  return {
    schemaVersion: 1,
    savedAt: typeof input.savedAt === 'string' ? input.savedAt : null,
    parameters: {
      tpb: requireNumber(parameters.tpb, '全局 TPB', 6, 96, true),
      saturation: requireNumber(parameters.saturation, '相对时间饱和', 1, 32),
      metric: parameters.metric,
      threshold: requireNumber(parameters.threshold, '匹配阈值', .5, 1),
      weights: Object.fromEntries(PARAMETER_FEATURE_KEYS.map((key) => [
        key,
        requireNumber(parameters.weights[key], `${key} 权重`, 0, 2),
      ])),
    },
  };
}

export function createParameterFile(parameters, savedAt = new Date().toISOString()) {
  return normalizeParameterFile({ schemaVersion: 1, savedAt, parameters });
}
