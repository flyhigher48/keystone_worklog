// Embedding model for the assistant's meaning search. Runs off the main thread so the page
// stays responsive. The library and model are downloaded once by the Flask app and then served
// locally from data/models/, so nothing leaves the computer after the first run.
import { pipeline, env } from '/cdn/npm/@huggingface/transformers@3.0.2/dist/transformers.min.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';  // ~23 MB quantised, 384-dimension vectors
env.allowLocalModels = false;
env.remoteHost = self.location.origin + '/hf/';
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.backends.onnx.wasm.wasmPaths = self.location.origin + '/cdn/npm/@huggingface/transformers@3.0.2/dist/';
env.backends.onnx.wasm.numThreads = 1;

let extractor = null;
function load() {
  extractor ||= pipeline('feature-extraction', MODEL, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: p => { if (p.status === 'progress') postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total }); },
  });
  return extractor;
}

self.onmessage = async e => {
  const { id, texts } = e.data;
  try {
    const run = await load();
    const out = await run(texts, { pooling: 'mean', normalize: true });
    postMessage({ id, vectors: out.tolist() });
  } catch (err) {
    extractor = null;
    postMessage({ id, error: String((err && err.message) || err) });
  }
};
