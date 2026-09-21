# Global Dialogues raw-data explorer

Implements `../global-dialogues/docs/plan_mosaic_explorer.md`: Python ETL to parquet, DuckDB-WASM
in the browser, Mosaic for linked views. Status: **M0–M6 built** (all ten rounds; Polls, Trends and
Answers pages; static deploy with an optional server mode).

```
make explorer-data      # ../global-dialogues/Data/GD* -> explorer/public/data/*.parquet + build_report.json
make explorer-dev       # http://localhost:5173/polls.html   (hello.html = vgplot toolchain check)
make explorer-build     # static site in explorer/dist (parquet included under dist/data)
```

`make explorer-data ROUNDS="GD8 GD9" DATA=/path/to/Data` overrides the defaults. Needs `uv` and
Node ≥ 20. Versions are pinned in `explorer/package.json` (Mosaic 0.31.0, Plot 0.6.17, Vite 8.3.0).

## Pages

- **Polls**: one poll in one round as 100 % stacked bars (or % selecting, for multi-select) per
  group of a split-by dimension. Minimum-n greying, show-more and per-group show/hide, table view,
  click a segment to read those participants' open-ended answers.
- **Trends**: one recurring Indicator across rounds, a small panel per group: share choosing the
  headline options, Wilson 95 % band computed in SQL, n per round as a strip under each panel,
  hollow points below the minimum n. GD6UK is off by default and, when on, is a separate marker
  that is never joined to the line. Click a panel for the full distribution per round; the question
  wording per round is one click away. Rounds are independent samples and the page says so.
- **Answers**: every open-ended answer in full, English with the original on demand; search,
  tag, sentiment, sort; raw vote counts as a bar, Remesh's imputed rate separately and labelled
  an estimate. "Participant" opens everything that person answered and how they voted;
  "Votes by group" shows raw agree / disagree / neutral counts by segment, greyed with a warning
  under n = 5. Branched follow-ups ("Branch A - …") show the poll they follow and the
  answers that routed people into them.

- **Deep consensus**: one claim as a probabilistic dependency graph (stance, reason theme,
  group) with between-group inconsistency in bits, permutation nulls and a power check; labels
  each group pair deep / shallow / underpowered per stance. Precomputed by
  `tools/pdg/build_claim_pdg.py`; see `tools/pdg/README.md` for the numbers.

Every page has the same demographic cross-filter column (Mosaic clients on one crossfilter
`Selection`) and keeps its whole state in the URL.

## Layout

```
tools/explorer/build_parquet.py   ETL, writes build_report.json and exits non-zero on a failed check
tools/explorer/region_lookup.csv  country -> UN M49 region / sub-region (Remesh's 197 labels)
explorer/src/coordinator.js       DuckDB (WASM or server) + Mosaic coordinator, table loading, views
explorer/src/shared.js            filter panels, chips, tooltip, searchable menu, theme
explorer/src/colors.js            option list -> diverging / ordered / categorical fills
explorer/src/polls.js  trends.js  answers.js      one module per page
explorer/src/theme.css            light + dark tokens
```

## Deploy

Static (default): copy `explorer/dist/` anywhere. Paths are relative, so a sub-path works. About
120 MB on disk, of which a browser downloads one DuckDB build (~8 MB gzipped) plus ~30 MB of
parquet, once, then caches.

```nginx
location /gd/ {
    alias /srv/gd-explorer/dist/;
    index polls.html;
    # .wasm must be served as application/wasm: nginx >= 1.21 does this out of the box;
    # on older versions add `application/wasm wasm;` to mime.types.
    gzip on;
    gzip_types application/wasm application/javascript text/css;
    location ~* \.(wasm|js|css)$ { add_header Cache-Control "public, max-age=31536000, immutable"; }
    location ~* \.parquet$       { add_header Cache-Control "no-cache"; }   # revalidate after a rebuild
}
```

Server mode (optional, if load time ever matters): run Mosaic's DuckDB server next to the data and
build the front end against it; the browser then downloads no WASM and no parquet.

```
uvx duckdb-server                                   # websocket on :3000, proxy it as wss://host/gd-db
VITE_DUCKDB_SERVER=wss://host/gd-db VITE_DATA_DIR=/srv/gd-explorer/data npm run build
```

`duckdb-server` executes any SQL it receives, so keep it behind the same access control as the
site. Nothing in either mode is sent to a third party: DuckDB-WASM is bundled, not loaded from a CDN.


