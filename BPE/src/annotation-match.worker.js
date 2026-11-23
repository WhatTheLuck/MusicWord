import { findSimilarAnnotationSegments } from './annotation-match';

self.onmessage = ({ data }) => {
  try { self.postMessage(findSimilarAnnotationSegments(data)); }
  catch (error) { self.postMessage({ error: error.message || '查找失败，请调整参数后重试' }); }
};
