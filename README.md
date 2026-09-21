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
  under n = 5.

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

## Where this departs from the plan, and why

- **Lives in its own directory** instead of inside the `global-dialogues` repo; the data path is
  a parameter. Generated parquet is gitignored. The repo had no `.venv`, so `make` creates one here.
- **Question identity comes from `aggregate_standardized.csv`**, not `question_id_mapping.csv`.
  The mapping file repeats a UUID for questions that share a text prefix (GD9 rows 16/17, 22–24,
  43/45/47, 78/79) and has no Rank questions. Only identity, type, survey order and option order
  are read from the aggregate; no rates except `agree_rate_imputed_all`. Option order is
  cross-checked against the discussion guide (`option_order_differs_from_guide`: empty in all rounds).
- **Extra table `poll_options`** so options nobody chose still exist and sort correctly;
  `questions` also carries `is_onboarding` and `demographic`.
- **Parquet is written to `explorer/public/data/`** (Vite's static dir) rather than `explorer/data/`.
- **Views are hand-rendered Mosaic clients** (HTML bars; Observable Plot for the trend panels), not
  vgplot marks: they need per-row n, below-minimum greying, show/hide, Wilson intervals from custom
  SQL and click-through. vgplot itself is wired up and proven in `hello.html` for the later map.
- **Answers pages through the list** ("show 40 more") instead of virtualising it.
- **n on Trends is a strip under each panel**, a separate chart on its own scale, not a second axis.
- `pairwise.parquet` is built but not loaded by any page yet. Rank questions are in `questions`
  but have no answers table. The "Please enter your Prolific ID" free-text question is dropped from
  `statements`; `sample_id` is never shown.

## What the ETL found (all in `build_report.json`)

- Participants, Ask-Opinion statements, votes and pairwise counts equal `Data/README.md` for all
  ten rounds; respondents per poll equal Remesh's `segment_counts_by_question` for every poll.
- Indicators matched by text: 39/39 in GD3, 38/39 in GD4, GD6, GD6UK, GD7, GD8, GD9 (the missing one,
  `trust_personal_ai_chatbot_why_ot`, is an open-ended item worded differently after GD3) and
  17/39 in GD5, which really did ask a reduced set. When a round asks the same wording twice
  (GD5–GD7: a repeat later in the survey, or a second scale), only the first asking carries the
  code (`indicator_repeats_ignored`).
- Option wording drifts: "Neither Trust nor Distrust" in GD5, and `community_automation_impact`
  changed "several people" to "a few people" from GD6. Trends matches options case-insensitively;
  the second change shows up as two separate options.
- **GD5 tags cannot be joined**: `GD5/tags/all_thought_labels.csv` uses participant and question
  IDs that appear nowhere else in GD5 (a different export). GD1 tags cover 12 of 17 questions.
  Those statements have empty tags.
- GD6UK has one Ask-Opinion question present in `verbatim_map`/`binary` but absent from the
  aggregate; it is kept, without original-language text or the Remesh estimate.
- "Turkey" (GD1, GD2) is normalised to "Türkiye". 3 to 43 votes per round point at a Thought ID
  missing from `verbatim_map` (`votes_orphan_thought`); they stay in `votes` and drop out of joins.
