# Handoff: deep vs shallow consensus as a microbelief PDG

Written 2026-09-21 for the agent that continues this on the cluster. Read in this order:
the brief the user pasted (reproduced in §1), `tools/pdg/README.md` (what v1 computed and
found), then this file. Background: `global-dialogues/papers/README.md` §1–§5 and
`global-dialogues/docs/pdg_dialogues_notes.md` §2–§3.

Local machine ran out of disk (434 MB free while `uv` was provisioning torch for the
pdg-capetz editor), which is why this moves to the cluster. Nothing here needs a GPU.

## 0. State of the code (all committed in this repo)

| what | where | status |
|---|---|---|
| explorer app (Polls, Trends, Answers) | `explorer/`, `tools/explorer/` | done, user has reviewed |
| PDG builder **v1** (R = one 12-valued node) | `tools/pdg/build_claim_pdg.py` | works, numbers in `tools/pdg/README.md`, **superseded by §2** |
| Deep-consensus page v1 (hand-drawn SVG) | `explorer/pdg.html`, `explorer/src/pdg.js` | works, **to be replaced by the pdg-capetz editor, §3** |
| `pdg` library | `../pdg-capetz` (fork of orichardson/pdg; Python byte-identical to upstream) installed editable into `.venv` with `cvxpy`, `clarabel`, `fastapi`, `uvicorn` | nothing in pdg-capetz was modified yet |

Setup on the cluster (paths there per the brief: `/nas/ucb/marimeireles/{global-dialogues,pdg-capetz}`;
clone this repo next to them: `git@github.com:marimeireles/global-dialogues-explorer.git`, and
check the `pdg-capetz` there is at or after commit `cffc1a3`):

```
uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python -r requirements.txt \
    -e ../pdg-capetz cvxpy clarabel fastapi uvicorn
make explorer-data                       # CSV -> explorer/public/data/*.parquet (gitignored)
.venv/bin/python tools/pdg/build_claim_pdg.py   # v1, ~75 s, only to reproduce README numbers
cd explorer && npm install && npm run dev       # http://localhost:5173/pdg.html
```

## 1. What the user asked for, and why v1 is wrong

The brief (2026-09-21, "Brief: a PDG of one survey claim, its reasons, and deep vs shallow
consensus"): PDG of one GD3 claim with variables S stance, R reason (Remesh theme), G group;
tables from counts + 0.5 pseudo-counts, β = people per table; per group pair: vote-level
inconsistency, reason-level inconsistency per stance, combined score, 200 label-permutation
null, power check; labels deep / shallow / underpowered; a page drawing the PDG with arrow
width = β and colour = per-arc inconsistency, hover → data; readout table; group switcher.
"Style after pdg-capetz/viz so it can be merged into the editor later." No LLM anywhere.

v1 implemented that literally with R as **one node with 12 values**. The user's correction:

> we want to measure inconsistency … disagree about A, agree about a1 a2 a3 these are the
> microbeliefs, and then agree about B but disagree in microbeliefs b1 b2 … why isn't the
> graph showing that. Also I asked you to use the pdg-capetz that's in the above directory.

Two defects:

1. With R as a single multi-valued node the inconsistency can only say "the reason tables
   differ"; it cannot land on a specific reason. The graph must show, per claim, whether
   groups split on the vote (A) and on *which* reasons (a₁, a₂, …), and across several
   claims (A, B, …).
2. The graph must be the pdg-capetz editor (d3, `pdg-capetz/viz/`), not my own SVG. I used
   the fork's Python library for all numbers but drew my own picture.

## 2. The corrected model: microbeliefs as nodes

Per claim c and group dimension (country / feeling about AI):

- `S_c` binary: agree / disagree (the macro-belief).
- One **binary node per reason theme** `a_i`: {yes, no} = "this person's written reason was
  coded with theme i" (Remesh Tag 1; keep the v1 merging rule: themes with < 15 people →
  "other", drop "Uninformative answer" from the microbeliefs, keep those people in S).
- Per group g: arc `g: S` = ∅ → S_c with P_g(S), β = n_g; and per theme i: arc `g: a_i` =
  S_c → a_i with P_g(a_i | S), β = number of group-g people with a codeable reason.
- **No G variable**: the group is the *source* of each arc (its label). Then the PDG's
  inconsistency is exactly "how far the groups are from one shared model of the claim and
  its reasons", and it decomposes per arc: the `g: S` arcs carry the vote-level
  disagreement, each `g: a_i` arc carries the disagreement about microbelief i. That is the
  picture the user described: dark arcs into S = they disagree about A; dark arcs into a₂ =
  they agree about A but not about a₂.

Numbers to compute, per (claim, dimension):

1. **Joint PDG** (all groups): `⟨⟨M⟩⟩₀` and per-arc bits → arc colours in the editor.
2. **Per pair, per stance s, per microbelief i**: `{P_A(a_i|s), P_B(a_i|s)}` on one binary
   node, β = the two cell counts. This is a 2-cell two-source problem with the closed form
   `−(n_A+n_B)·log Σ_x p^λ q^{1−λ}`, λ = n_A/(n_A+n_B) (Lemma 6.10); the solver agrees with
   it to 1e-4 nats (checked in v1). Use the solver for the observed cells and the closed
   form for the ~40 000 permutation-null solves, and assert their agreement on the observed
   cells in the report.
3. **Vote level per pair**: `{P_A(S), P_B(S)}`, as in v1.
4. **Null**: permute group labels 200 times, recompute 1–3. For 1 the joint solve is the
   expensive part (see §4); 50 permutations of the joint is acceptable if 200 is too slow,
   say so in the report.
5. **Power check per (pair, stance, microbelief)**: as in v1 — effect size = bits per person
   (scale-free: inconsistency is homogeneous of degree 1 in (β_A, β_B)); threshold = median
   bits/person over all *other* cells × (n_A+n_B); "deep" only if threshold > that cell's null
   95th percentile. Labels: deep / underpowered / shallow, per microbelief.
6. Do it for **all four GD3 agree/disagree claims** (the user's sketch has A and B): polls
   at survey order 56, 58, 60, 62 with reason questions 57, 59, 61, 63 (`questions.parquet`,
   round GD3). Question ids and counts:

   | order | poll id | reason id | agree / disagree | claim (from the discussion guide "speak" item before it) |
   |---|---|---|---|---|
   | 56 | c909ca6a-… | 0443cd28-… | 883 / 55 | disclosure of AI involvement |
   | 58 | 18e6fbb1-… | 52e883fc-… | 850 / 87 | transparency of AI decisions |
   | 60 | b6c5e939-… | fc1af587-… | 359 / 578 | **AI agents making financial decisions** (the brief's claim; its "col 105" was off by one block) |
   | 62 | ec5fd6c7-… | b665aaae-… | 596 / 339 | AI responding to messages with consent |

   Full ids: `SELECT question_id, order_in_survey FROM questions WHERE round='GD3' AND order_in_survey BETWEEN 56 AND 63`.
   Get the claim wording from `Data/GD3/GD3_discussion_guide.csv` (item type `speak`, text
   starting "Consider the following proposal").

Reuse from `build_claim_pdg.py`: `load_people` (join of poll answer, statement + tag,
demographics), `group_of`, smoothing, `solve`/`solve_with_arcs`, the permutation pool
(`fork` context, module-level `_CTX`), `null_summary`, the power/label block, and the
answers list for hover. Write a new `tools/pdg/build_microbelief_pdg.py` rather than
mutating v1, so the README numbers stay reproducible.

## 3. Use the pdg-capetz editor for the drawing

Findings about `pdg-capetz/viz` (read `viz/server.py`, `viz/pdgviz.js` ~lines 655–800 and
1040–1130, `viz/pdg-view.js` `load()` ~line 140 and `set_edge_scores` ~line 1490):

- **Model format** (`viz/examples/*.json`): `{"nodes": [...], "hedges": {label: [[srcs],
  [tgts]]}, "cpds": {label: {srcKey: {tgtValue: p}}}, "alpha": {label: a}, "beta": {label: b},
  "viz": {"nodes": {id: {x, y, w, h}}, "linknodes": [[label, {x, y, w, h}]], "links": [...]}}`.
  Unconditional arcs have `srcs: []` and the single cpd key `"⋆"`. Domains are inferred from
  the cpd keys/values (`_infer_domains`); a node with no cpd gets {name, ~name}.
  Multi-source keys are `"s1, s2"` strings. Labels must not contain `|` or `->`.
- **Catalog**: `viz/examples/catalog.json` is a list of `{file, title, source, tier, note,
  gamma, epsilon, iters}`; the picker groups by `tier`. `make examples` *regenerates* the
  catalog from `viz/gen_catalog_examples.py` — so either add our models to that generator
  (preferred: "edit the generator, never the files") or write them with a separate
  generator that appends a "Global Dialogues" tier and is called from ours.
- **Scores**: `/api/score` evaluates the **factor product** of the cpds, which is not the
  inconsistency minimiser and is meaningless for several arcs into one node from different
  groups. The real per-arc numbers come from `/api/optimize` (`algorithm: "torch"` default,
  `"cvxpy"` = `cvx_opt_joint`). `edge_scores` → `pdg.set_edge_scores` → arc colour ramp
  grey → `--pdg-red`, normalised to the largest finite arc; ∞ has its own colour; width = β
  via `beta_scale`. The readout drawer shows marginals, top atoms, mutual information.
- **Model selection** is only the dropdown (`loadExample(file)` in pdgviz.js). Add a
  `#model=<file>` (or `?model=`) hash so the explorer can link straight to a model, and a
  catalog flag (e.g. `"optimize": "cvxpy"`) so these models optimise on load instead of
  showing factor-product scores. The user said pdg-capetz may be changed freely; keep the
  Python byte-identical to upstream (the fork's stated rule) and change only `viz/`.
- **Running it**: `make viz` = `uv run --extra web viz/server.py` (needs Python 3.12 +
  torch, ~2 GB; that is what filled the disk). Cheaper: from this repo's venv, which already
  has torch + fastapi + uvicorn, `cd ../pdg-capetz && PORT=8080 ../gd-dashboard/.venv/bin/python
  viz/server.py`. Not yet verified to start; if the fork's `viz/server.py` imports assume
  Python 3.12 syntax, use its own `uv` env on the cluster where disk is not a problem.
- Precompute per-arc bits in Python (our solver run) **and** keep the editor's Optimize
  working; the two should agree — put the comparison in the README.

Layout to pin in `viz.nodes`: `S_c` at the left-centre; the microbeliefs `a_i` in a column to
the right ordered by count; link-nodes for the per-group arcs fanned between them, one
column per group so the group reads as a colour/label band. Node ids are variable names, so
use readable theme names (truncate; keep a map to the full Remesh tag in the catalog note or
a sidecar JSON for the explorer's hover).

What the explorer page keeps: the readout (per claim × dimension × stance: a matrix
microbelief × group pair, coloured deep / shallow / underpowered, vote row on top), hover →
the two P(a_i|s) proportions with counts, null band, power verdict, and the reason texts
under that theme for those two groups; a link/iframe to the editor at `#model=…`. Drop the
hand-drawn SVG graph from `src/pdg.js`.

## 4. Solver facts (measured here)

- `cvx_opt_joint` with CLARABEL on the star PDG (S + k binary microbeliefs, 5 groups, all arcs):
  k = 6: 0.2 s · k = 8: 0.7 s · k = 9: 1.4 s · k = 10: 2.1 s "optimal_inaccurate" ·
  k = 11: **CLARABEL fails**; SCS solves k = 11 in 398 s "optimal_inaccurate". So the joint
  program is fine up to ~9 microbeliefs. Options, in order of preference:
  1. The PDG is a **tree** (every arc is ∅→S or S→a_i), so `ip.cvx_opt_clusters(M,
     varname_clusters=[(S, a_i) for each i], solver="CLARABEL")` is exact and tiny
     (Cor 8.6.1). It ran but the value is not on `cvx_opt_clusters.prob` (AttributeError) —
     read `interior_pt.py` lines 183–300 to see where it stores the problem / returns the
     value, and check it against `cvx_opt_joint` at k = 8 before trusting it.
  2. Cap at the top 9 microbeliefs + "other" per claim.
  3. Two-source cells never need the joint: they are 2-cell problems with a closed form.
- Two-source single-node problems: 0.017 s each with CLARABEL; closed form (Lemma 6.10)
  matches to 1e-4 nats on 14-cell tables with 0.5 pseudo-counts. (v1's first check showed a
  24-nat "mismatch" that was float underflow in `p**120` on my side, not the solver.)
- Always smooth (0.5 pseudo-counts); a hard zero makes the inconsistency infinite.
- The editor's torch `opt_joint` is gradient descent on the full joint: fine at 2^12 worlds
  for display, but its number is approximate; report the cvx value as the number of record.

## 5. Things the user has decided (do not re-ask)

- No LLM summarisation or LLM-written labels anywhere; ask before any step where a model
  interprets participant text. Remesh Tag 1 is the reason axis for now; the later step
  swaps it for components learned from Gemma activations (hook: only the "theme" column
  changes).
- Explain before running long jobs.
- UI: never fold groups into "Other (N groups)"; show all, collapse long lists behind
  "show more", per-group show/hide toggles; demographic questions stay out of question
  menus; sober palette with clearly distinct ramp steps.
- The user trimmed this repo's README once ("rm useless info"); keep README additions short
  and put findings in `tools/pdg/README.md`.

## 6. Open questions to raise with the user (not blockers)

- Should the four claims share one editor model (four S nodes, ~40 microbeliefs; too big
  for the exact joint, fine for the tree program and for torch) or one model per claim
  (recommended; the catalog groups them)?
- "other countries" pools 60+ countries; a shallow cell against it says "India differs from
  the pool". Acceptable for now?
- Second theme (Tag 2) as extra microbeliefs: easy (a person can carry several yes's), but
  doubles the arcs; propose after the Tag-1 version is reviewed.
