/**
 * Worker thread entry for `OxigraphQueryExecutor`. Holds a private oxigraph
 * `Store` replica loaded from the adapter's N-Quads file and runs one query
 * at a time. Must be loaded as a worker (`worker_threads`), never imported.
 */
import { parentPort } from 'worker_threads';
import { promises as fs } from 'fs';
import oxigraph from 'oxigraph';
import { convertOxigraphResult } from './oxigraphResult.js';

interface Request { id: number; dataFile: string; query: string }

let store = new oxigraph.Store();
let loadedSignature: string | null = null;

async function refresh(dataFile: string): Promise<void> {
  let signature: string;
  try {
    const st = await fs.stat(dataFile);
    // The adapter replaces the file by rename, so the inode changes on every write.
    signature = `${dataFile}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    signature = `${dataFile}:missing`;
  }
  if (signature === loadedSignature) return;

  const next = new oxigraph.Store();
  if (!signature.endsWith(':missing')) {
    const data = await fs.readFile(dataFile, 'utf-8');
    if (data.trim().length > 0) {
      next.load(data, { format: 'application/n-quads' });
    }
  }
  store = next;
  loadedSignature = signature;
}

parentPort!.on('message', async (req: Request) => {
  try {
    await refresh(req.dataFile);
    // Tell the parent the deadline clock may start: loading is not charged to the query.
    parentPort!.postMessage({ id: req.id, kind: 'started' });
    const result = convertOxigraphResult(store.query(req.query));
    parentPort!.postMessage({ id: req.id, kind: 'result', result });
  } catch (e) {
    parentPort!.postMessage({ id: req.id, kind: 'error', message: (e as Error).message });
  }
});
