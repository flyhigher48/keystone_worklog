// Embedding model for the assistant's meaning search. Runs off the main thread so the page
// stays responsive. The library and model are downloaded once by the Flask app and then served
// locally from data/models/, so nothing leaves the computer after the first run.
//
// Speed: on a computer with a GPU (WebGPU in Edge / Chrome, recent Firefox) the model runs there – many
// times faster on batches. Otherwise it runs on the CPU, with several threads when the page is
// cross-origin isolated (Keystone sends those headers), else one.
import { pipeline, env } from '/cdn/npm/@huggingface/transformers@3.0.2/dist/transformers.min.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';  // 384-dimension vectors; q8 (~23 MB) on the CPU, fp32 (~90 MB) on the GPU
env.allowLocalModels = false;
env.remoteHost = self.location.origin + '/hf/';
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.backends.onnx.wasm.wasmPaths = self.location.origin + '/cdn/npm/@huggingface/transformers@3.0.2/dist/';
const cores = (self.navigator && navigator.hardwareConcurrency) || 1;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1;

let extractor = null, device = '', prefer = 'auto', note = '';
const progress = p => { if (p.status === 'progress') postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total }); };
const make = dev => pipeline('feature-extraction', MODEL, { dtype: dev === 'webgpu' ? 'fp32' : 'q8', device: dev, progress_callback: progress });

async function gpuAvailable() {
  try {
    if (!self.navigator || !navigator.gpu) return false;
    return !!(await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }));
  } catch { return false; }
}
function load() {
  extractor ||= (async () => {
    if (prefer !== 'cpu' && await gpuAvailable()) {
      try {
        const ex = await make('webgpu');
        await ex(['warm up'], { pooling: 'mean', normalize: true });  // fail here, not halfway through indexing
        device = 'webgpu'; note = '';
        return ex;
      } catch (err) { note = `GPU not usable (${(err && err.message) || err}) – using the CPU`; }
    }
    const ex = await make('wasm');
    device = 'wasm';
    return ex;
  })();
  return extractor;
}

self.onmessage = async e => {
  const { id, texts } = e.data;
  if (e.data.prefer && e.data.prefer !== prefer) { prefer = e.data.prefer; extractor = null; }
  try {
    const run = await load();
    const out = await run(texts, { pooling: 'mean', normalize: true });
    postMessage({ id, vectors: out.tolist(), device, threads: env.backends.onnx.wasm.numThreads, note });
  } catch (err) {
    extractor = null;
    postMessage({ id, error: String((err && err.message) || err) });
  }
};
