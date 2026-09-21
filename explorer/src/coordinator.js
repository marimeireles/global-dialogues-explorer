// One place that knows how the app talks to DuckDB. Pages import `initData`, `sql` and
// `coordinator`; switching to Mosaic's socket connector (duckdb-server) only touches
// `makeConnector`.
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { coordinator as getCoordinator, socketConnector, wasmConnector } from '@uwdata/mosaic-core';

// pairwise.parquet (13 MB) is built but no page reads it yet, so it is not loaded.
const TABLES = ['participants', 'questions', 'poll_options', 'poll_answers', 'statements', 'votes'];

// Denormalised views from the plan (section 4). Later columns (pdg_group, x, y, ...) added
// to the parquet files flow through `select *` untouched.
const VIEWS = `
CREATE OR REPLACE VIEW poll_answers_x AS
  SELECT a.*, p.* EXCLUDE (round, round_order, participant_id, sample_id)
  FROM poll_answers a JOIN participants p USING (round, participant_id);
CREATE OR REPLACE VIEW statements_x AS
  SELECT s.* EXCLUDE (language), s.language AS text_language,
         p.* EXCLUDE (round, round_order, participant_id, sample_id)
  FROM statements s JOIN participants p USING (round, participant_id);
CREATE OR REPLACE VIEW votes_x AS
  SELECT v.*, p.* EXCLUDE (round, round_order, participant_id, sample_id),
         s.participant_id AS author_id, s.tag_1, s.sentiment
  FROM votes v
  JOIN participants p ON p.round = v.round AND p.participant_id = v.voter_id
  JOIN statements s ON s.round = v.round AND s.thought_id = v.thought_id;
`;

// Optional server mode: build with VITE_DUCKDB_SERVER=wss://host/path and the browser talks
// to Mosaic's `duckdb-server` over a websocket instead of running DuckDB-WASM.
// VITE_DATA_DIR is where that server finds the parquet files (a path on the server).
const SERVER = import.meta.env.VITE_DUCKDB_SERVER;
const SERVER_DATA = import.meta.env.VITE_DATA_DIR ?? 'data';

async function makeConnector() {
  if (SERVER) return socketConnector({ uri: SERVER });
  // Bundles are served from our own origin (no CDN), so the app works offline / self-hosted.
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(bundle.mainWorker));
  await db.instantiate(bundle.mainModule);
  return wasmConnector({ duckdb: db });
}

let ready;

/** Start DuckDB, load every parquet table into memory and create the views. Idempotent. */
export function initData(onProgress = () => {}) {
  ready ??= (async () => {
    onProgress('Starting DuckDB…');
    const coord = getCoordinator();
    coord.databaseConnector(await makeConnector());
    const dataUrl = SERVER ? null : new URL('data/', document.baseURI);
    for (const t of TABLES) {
      onProgress(`Loading ${t}…`);
      await coord.exec(`CREATE OR REPLACE TABLE ${t} AS SELECT * FROM read_parquet('${SERVER ? `${SERVER_DATA}/${t}.parquet` : new URL(`${t}.parquet`, dataUrl)}')`);
    }
    await coord.exec(VIEWS);
    return coord;
  })();
  return ready;
}

export const coordinator = getCoordinator;

/** Run a query outside any client and get plain row objects (BigInt counts become numbers). */
export async function sql(query) {
  const table = await getCoordinator().query(query);
  return table.toArray().map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
    return out;
  });
}

/** SQL string literal. */
export const lit = (v) => (v == null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);

/** Turn the predicate list Mosaic hands to `client.query(filter)` into `AND …` SQL. */
export function andFilter(filter) {
  const parts = [filter ?? []].flat().map(String).filter(Boolean);
  return parts.length ? ` AND ${parts.map((p) => `(${p})`).join(' AND ')}` : '';
}
