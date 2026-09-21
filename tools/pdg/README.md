# Deep vs shallow consensus on one claim, as PDG inconsistency

Implements the "PDG of one survey claim" brief. Everything lives in this repo (the brief's
`dissent-explorer` does not exist on this machine): the builder is
`tools/pdg/build_claim_pdg.py`, the page is `explorer/pdg.html` + `explorer/src/pdg.js`
("Deep consensus" in the explorer's nav), the numbers are `explorer/public/data/pdg_gd3_q14.json`.

```
make explorer-data                                   # parquet tables the builder reads
.venv/bin/python tools/pdg/build_claim_pdg.py        # 200 permutations, ~75 s on 8 cores
make explorer-dev                                    # then open /pdg.html
```

The `pdg` package is Richardson's library, installed editable from `../pdg-capetz` (a fork
whose Python is byte-identical to upstream) with `cvxpy` + `clarabel`.

## The claim and data

GD3, "AI agents should be able to make financial decisions (e.g., buying and selling stocks)
on the user's behalf." Poll `b6c5e939…` (the third "Do you agree or disagree?" of the round, the
brief's positional index was off by one block): **Agree 359 / Disagree 578**. Reason question
`fc1af587…`, 937 people wrote one; 852 have a codeable Remesh theme (85 "Uninformative answer"
are kept for S and dropped from R). Themes with fewer than 15 people merge into "other"
(12 themes remain). Groups: country (India 177, Kenya 141, China 68, United States 50, other
501) and feeling about AI (equally 514, more excited 320, more concerned 103).

## What is computed (all with `pdg.alg.interior_pt.cvx_opt_joint`, CLARABEL, γ = 0)

Tables are counts + 0.5 pseudo-counts; β = the number of people the table came from; results
are bits × people. Per pair of groups (A, B):

- **vote**: `{P_A(S), P_B(S)}` on one S node, β = n_A, n_B;
- **reason, per stance s**: `{P_A(R|s), P_B(R|s)}` on one R node, β = the two cell counts;
- **combined**: `⟨⟨M_A + M_B⟩⟩ − ⟨⟨M_A⟩⟩ − ⟨⟨M_B⟩⟩` with `M_g = {∅→S, S→R}`, per arc;
- **null**: group labels permuted 200 times, everything recomputed: mean, sd, 95th percentile;
- **power**: two tables on one node have inconsistency `(n_A+n_B)·D(p‖q)` with `D` a Rényi
  divergence that does not depend on the scale, so bits/person is the scale-free effect size.
  A cell is "deep" only if the median bits/person of all *other* reason cells, applied at this
  cell's n, would exceed this cell's null 95th percentile; otherwise "underpowered".

The solver was checked against the closed form of Lemma 6.10 (agreement to 1e-4 nats on
14-cell tables). Also computed, for the drawing: all groups' `∅→S` and `S→R` tables on one
S and one R node ("joint"), whose per-arc terms colour the arrows.

## Results (seed 0, 200 permutations)

Vote level (bits, null 95th): pairs that vote differently are Kenya–China 4.3 (2.4),
Kenya–other 3.5 (2.7), China–US 5.0 (2.9), US–other 3.8 (2.5), India–China 2.9 (2.8), and
equally-vs-more-excited 8.2 (2.8). All other pairs are within the null band.

Reason level, per stance (bits / null 95th → label):

| pair | among "agree" | among "disagree" |
|---|---|---|
| India · Kenya | 6.9 / 10.4 underpowered | 8.1 / 11.7 underpowered |
| India · China | 7.3 / 8.3 underpowered | 4.2 / 9.3 underpowered |
| India · United States | 6.6 / 7.3 underpowered | 7.3 / 9.6 underpowered |
| India · other countries | **21.9 / 11.8 shallow** | **14.1 / 11.4 shallow** |
| Kenya · China | **8.5 / 8.4 shallow** | 4.4 / 9.8 underpowered |
| Kenya · United States | 6.3 / 7.7 underpowered | 7.3 / 9.7 underpowered |
| Kenya · other countries | 11.2 / 11.4 underpowered | **5.7 / 12.7 deep** |
| China · United States | 1.2 / 7.0 underpowered | 4.6 / 8.0 underpowered |
| China · other countries | 3.3 / 8.2 underpowered | **9.0 / 10.9 deep** |
| United States · other countries | 2.0 / 8.2 underpowered | **7.1 / 10.1 deep** |
| equally · more excited | 9.6 / 11.7 underpowered | **6.6 / 11.7 deep** |
| equally · more concerned | 3.7 / 10.8 underpowered | **6.0 / 12.2 deep** |
| more excited · more concerned | 3.4 / 9.6 underpowered | 5.5 / 13.1 underpowered |

Joint (all groups on one model): country 81.9 bits, feeling 33.7 bits.

Reading: the only reason-level differences that clear the null are India vs the rest of the
world on *both* stances, and Kenya vs China among agreers — shallow consensus, same vote and
different reasons. Every "deep" cell is on the *disagree* side (the larger stance), where the
sample is big enough for the power check: disagreers in Kenya, China, the US and across the
three AI-feeling groups give the same mix of reasons as the rest. Among agreers no cell is
powered except India–other and Kenya–China, which are the shallow ones. Small groups are never
called deep: the "agree" column is mostly underpowered because the agree cells have 17 to 64
people per group.

## Caveats

- R is Remesh's Tag 1: inherited codes, one codebook per question. "Indistinguishable at the
  tag level" is weaker than "the same reasons"; the planned finer test (components learned
  from the answers' own activations) plugs into the same builder by replacing `theme`.
- "other countries" pools 60+ countries; a shallow cell against it says India differs from
  the pool, not from any one country.
- With 26 reason cells and a 95th-percentile threshold, about one shallow call is expected
  by chance across the table.
- The `combined` per-pair score and the joint model weight each group's `S→R` table by
  the fitted μ(S), not by the cell counts; the per-stance test is the one the labels use.
