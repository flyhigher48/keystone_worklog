// Embedding model for the assistant's meaning search. Runs off the main thread so the page
// stays responsive. The library and model are downloaded once by the Flask app and then served
// locally from data/models/, so nothing leaves the computer after the first run.
//
// Speed: on a computer with a GPU (WebGPU in Edge / Chrome, recent Firefox) the model runs there – many
// times faster on batches. Otherwise it runs on the CPU, with several threads when the page is
// cross-origin isolated (Keystone sends those headers), else one.
//
// WebGPU isn't equally good everywhere: on some Linux drivers the adapter request never answers, or the model
// runs but returns NaN or wrong numbers. So the GPU is only used after its results match the CPU's on a test
// sentence, every GPU batch is checked, and anything doubtful falls back to the CPU for the rest of the session.
import { pipeline, env } from '/cdn/npm/@huggingface/transformers@3.0.2/dist/transformers.min.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';  // 384-dimension vectors; q8 (~23 MB) on the CPU, fp32 (~90 MB) on the GPU
env.allowLocalModels = false;
env.remoteHost = self.location.origin + '/hf/';
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.backends.onnx.wasm.wasmPaths = self.location.origin + '/cdn/npm/@huggingface/transformers@3.0.2/dist/';
const cores = (self.navigator && navigator.hardwareConcurrency) || 1;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1;

const CHECK = ['bearing replacement at pier 3', 'Keystone meaning search check'];
let extractor = null, cpu = null, device = '', prefer = 'auto', note = '', gpuFailed = false;
const progress = p => { if (p.status === 'progress') postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total }); };
const make = dev => pipeline('feature-extraction', MODEL, { dtype: dev === 'webgpu' ? 'fp32' : 'q8', device: dev, progress_callback: progress });
const withTimeout = (promise, ms, what) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms))]);
const embedWith = async (ex, texts) => (await ex(texts, { pooling: 'mean', normalize: true })).tolist();

/** Vectors are usable when every number is finite and each vector has length ~1 (they're normalized). */
function valid(vectors) {
  return Array.isArray(vectors) && vectors.every(v => Array.isArray(v) && v.length > 0 && v.every(Number.isFinite)
    && Math.abs(Math.hypot(...v) - 1) < 0.02);
}
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

async function gpuAvailable() {
  try {
    if (!self.navigator || !navigator.gpu) return false;
    return !!(await withTimeout(navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }), 5000, 'Asking for the GPU'));
  } catch { return false; }
}
const cpuModel = () => (cpu ||= make('wasm').catch(e => { cpu = null; throw e; }));

function load() {
  extractor ||= (async () => {
    if (prefer !== 'cpu' && !gpuFailed && await gpuAvailable()) {
      try {
        // the GPU model is ~90 MB: allow time to download it once; then it must agree with the CPU on a test sentence
        const ex = await withTimeout(make('webgpu'), 10 * 60000, 'Loading the model on the GPU');
        const g = await withTimeout(embedWith(ex, CHECK), 20000, 'The GPU test');  // one run at a time: the runtime refuses overlapping sessions
        const c = await embedWith(await cpuModel(), CHECK);
        if (!valid(g)) throw new Error('it returned invalid numbers');
        if (g.some((v, i) => cosine(v, c[i]) < 0.95)) throw new Error('its results don\'t match the CPU\'s');
        device = 'webgpu'; note = '';
        return ex;
      } catch (err) {
        gpuFailed = true;
        note = `GPU not usable (${(err && err.message) || err}) – using the CPU`;
      }
    }
    const ex = await cpuModel();
    device = 'wasm';
    return ex;
  })().catch(e => { extractor = null; throw e; });
  return extractor;
}

// one request at a time: a search query arriving during an indexing batch would otherwise overlap a running session
let queue = Promise.resolve();
self.onmessage = e => { queue = queue.then(() => handle(e)); };

async function handle(e) {
  const { id, texts } = e.data;
  if (e.data.prefer && e.data.prefer !== prefer) { prefer = e.data.prefer; extractor = null; if (prefer === 'auto') gpuFailed = false; }
  try {
    const run = await load();
    let vectors = await embedWith(run, texts);
    if (!valid(vectors)) {
      if (device !== 'webgpu') throw new Error('The embedding model returned invalid numbers on the CPU');
      // the GPU went bad mid-run: redo this batch on the CPU and stay there
      gpuFailed = true; note = 'The GPU returned invalid numbers – switched to the CPU';
      extractor = cpuModel(); device = 'wasm';
      vectors = await embedWith(await extractor, texts);
      if (!valid(vectors)) throw new Error('The embedding model returned invalid numbers on the CPU');
    }
    postMessage({ id, vectors, device, threads: env.backends.onnx.wasm.numThreads, note, gpuFailed });
  } catch (err) {
    extractor = null;
    postMessage({ id, error: String((err && err.message) || err), note, gpuFailed });
  }
}
