#!/usr/bin/env python3
"""Deep vs shallow consensus on one survey claim, as PDG inconsistency in bits.

    .venv/bin/python tools/pdg/build_claim_pdg.py            # GD3 financial-agents claim
    .venv/bin/python tools/pdg/build_claim_pdg.py --perms 20 # quick run

Variables: S stance (agree/disagree), R reason (Remesh theme of the free-text explanation),
G group (levels of one demographic dimension). Every table is an empirical count table
smoothed with 0.5 pseudo-counts; its confidence beta is the number of people it came from, so
an inconsistency is a total excess code length in bits x people. All numbers come from the
library's exponential-cone solver (Richardson 2024, Ch. 8); nothing is a made-up score.

Per pair of groups (A, B):
  vote     {P_A(S), P_B(S)} on one S node, beta = n_A, n_B
  reason   for each stance s: {P_A(R|s), P_B(R|s)} on one R node, beta = the counts in that cell
  combined <<M_A + M_B>> - <<M_A>> - <<M_B>> with M_g = {0->S, S->R}, decomposed per arc
Null: the group labels are permuted across people NPERM times and everything is recomputed.
Power: a cell is only called "deep" if a difference of the median per-person size seen in the
other reason cells would have exceeded this cell's null 95th percentile at this cell's n.
(Two tables with betas n_A, n_B on one node have inconsistency (n_A+n_B) x D(p||q) with D a
Renyi divergence independent of scale, so "per-person bits" is the scale-free effect size.)

Reads the explorer's parquet tables; writes explorer/public/data/pdg_<round>_<claim>.json.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import warnings
from itertools import combinations
from multiprocessing import get_context
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
from pdg.alg import interior_pt as ip  # noqa: E402
from pdg.dist import CPT  # noqa: E402
from pdg.pdg import PDG  # noqa: E402
from pdg.rv import Unit, Variable as Var  # noqa: E402

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "explorer" / "public" / "data"
LN2 = float(np.log(2))
SMOOTH = 0.5
MIN_THEME = 15
UNINFORMATIVE = "Uninformative answer"
STANCES = ["agree", "disagree"]

CLAIMS = {
    "gd3_q14": dict(
        round="GD3", label="GD3 · AI agents making financial decisions",
        claim="AI agents should be able to make financial decisions (e.g., buying and selling stocks) on the user's behalf.",
        poll_qid="b6c5e939-455a-4c81-a676-9be1bccaa582", reason_qid="fc1af587-5ded-4cbb-920a-52bea75ac0d8",
        stance_of={"Agree": "agree", "Disagree": "disagree"},
    ),
}
DIMS = {
    "country": dict(label="Country", column="country", keep=["India", "Kenya", "China", "United States"], other="other countries"),
    "ai_feeling": dict(label="Feeling about AI", column="ai_feeling", keep=None, other=None),
}


# ------------------------------------------------------------------------------ data

def load_people(c):
    """One row per participant: stance, theme (None if uninformative/missing), demographics."""
    polls = pd.read_parquet(DATA / "poll_answers.parquet")
    polls = polls[(polls["round"] == c["round"]) & (polls["question_id"] == c["poll_qid"])]
    stance = polls.set_index("participant_id")["option"].map(c["stance_of"]).dropna()
    st = pd.read_parquet(DATA / "statements.parquet")
    st = st[(st["round"] == c["round"]) & (st["question_id"] == c["reason_qid"])].drop_duplicates("participant_id")
    st = st.set_index("participant_id")
    people = pd.read_parquet(DATA / "participants.parquet")
    people = people[people["round"] == c["round"]].set_index("participant_id")
    df = pd.DataFrame({"stance": stance}).join(st[["text_en", "tag_1", "tag_2"]]).join(people[["country", "age", "gender", "ai_feeling", "religion"]])
    df = df[df["text_en"].notna()].copy()  # people with both a vote and an explanation
    df["theme_raw"] = df["tag_1"]
    counts = df["theme_raw"].value_counts()
    small = set(counts[counts < MIN_THEME].index) | {"Other"}
    df["theme"] = df["theme_raw"].where(~df["theme_raw"].isin(small), "other")
    df.loc[df["theme_raw"] == UNINFORMATIVE, "theme"] = None
    return df


def group_of(df, dim):
    d = DIMS[dim]
    g = df[d["column"]].fillna("(none)")
    if d["keep"]:
        g = g.where(g.isin(d["keep"]), d["other"])
    return g


# ------------------------------------------------------------------------------ PDGs

def solve(M):
    ip.cvx_opt_joint(M, also_idef=False, solver="CLARABEL")
    prob = ip.cvx_opt_joint.prob
    if prob.status not in ("optimal", "optimal_inaccurate"):
        raise RuntimeError(f"solver status {prob.status}")
    return prob.value / LN2


def solve_with_arcs(M):
    mu = ip.cvx_opt_joint(M, also_idef=False, solver="CLARABEL")
    total = ip.cvx_opt_joint.prob.value / LN2
    per_arc = dict(zip(M.edges("l"), (np.asarray(M.Inc(mu, ed_vector=True), dtype=float) / LN2).tolist()))
    return total, per_arc


def smooth(counts):
    c = np.asarray(counts, dtype=float) + SMOOTH
    return c / c.sum()


def one_node_two_sources(name, k, p, q, bp, bq):
    """{p^(bp), q^(bq)} on one k-valued node."""
    M = PDG()
    X = Var.alph(name, k)
    M += X
    M += ("A", CPT.from_matrix(Unit, X, np.asarray(p).reshape(1, -1)))
    M += ("B", CPT.from_matrix(Unit, X, np.asarray(q).reshape(1, -1)))
    M.set_beta("A", float(bp))
    M.set_beta("B", float(bq))
    return M


def group_pdg(M, S, R, tag, t):
    """Add group t's two arcs (0->S with beta n, S->R with beta n_reason) to M."""
    M += (f"S{tag}", CPT.from_matrix(Unit, S, np.asarray(t["pS"]).reshape(1, -1)))
    M.set_beta(f"S{tag}", float(t["nS"]))
    M += (f"R{tag}", CPT.from_matrix(S, R, np.asarray(t["pR"])))
    M.set_beta(f"R{tag}", float(max(t["nR"], 1e-9)))


def combined_pdg(tables, k):
    M = PDG()
    S, R = Var.alph("S", 2), Var.alph("R", k)
    M += S
    M += R
    for tag, t in tables.items():
        group_pdg(M, S, R, tag, t)
    return M


def tables_for(df, themes, groups):
    """Per group: smoothed P(S), P(R|S) and the counts they came from."""
    out = {}
    ti = {t: i for i, t in enumerate(themes)}
    for g in groups:
        sub = df[df["group"] == g]
        cS = np.array([(sub["stance"] == s).sum() for s in STANCES])
        cR = np.zeros((2, len(themes)))
        for si, s in enumerate(STANCES):
            for t, n in sub.loc[sub["stance"] == s, "theme"].dropna().value_counts().items():
                cR[si, ti[t]] = n
        out[g] = dict(nS=int(cS.sum()), cS=cS.tolist(), pS=smooth(cS).tolist(),
                      nR=int(cR.sum()), cR=cR.tolist(), pR=[smooth(row).tolist() for row in cR])
    return out


def pair_numbers(tables, a, b, k):
    ta, tb = tables[a], tables[b]
    vote = solve(one_node_two_sources("S", 2, ta["pS"], tb["pS"], ta["nS"], tb["nS"]))
    reason = {}
    for si, s in enumerate(STANCES):
        na, nb = sum(ta["cR"][si]), sum(tb["cR"][si])
        reason[s] = solve(one_node_two_sources("R", k, ta["pR"][si], tb["pR"][si], na, nb)) if na and nb else None
    Mab = combined_pdg({a: ta, b: tb}, k)
    total, per_arc = solve_with_arcs(Mab)
    single = solve(combined_pdg({a: ta}, k)) + solve(combined_pdg({b: tb}, k))
    return dict(vote=vote, reason=reason, combined=total - single, combined_arcs=per_arc)


def joint_numbers(tables, k):
    total, per_arc = solve_with_arcs(combined_pdg(tables, k))
    return dict(bits=total, arcs=per_arc)


def dim_numbers(df, themes, groups):
    k = len(themes)
    tables = tables_for(df, themes, groups)
    pairs = {f"{a}|{b}": pair_numbers(tables, a, b, k) for a, b in combinations(groups, 2)}
    return dict(tables=tables, pairs=pairs, joint=joint_numbers(tables, k))


# permutation worker: module-level so it forks cleanly
_CTX = {}


def _perm_job(args):
    dim, seed = args
    df, themes, groups = _CTX["df"].copy(), _CTX["themes"], _CTX["groups"][dim]
    rng = np.random.default_rng(seed)
    df["group"] = rng.permutation(group_of(df, dim).to_numpy())
    r = dim_numbers(df, themes, groups)
    return dim, dict(pairs={p: dict(vote=v["vote"], reason=v["reason"], combined=v["combined"]) for p, v in r["pairs"].items()},
                     joint=r["joint"]["bits"])


def null_summary(values):
    v = np.array([x for x in values if x is not None], dtype=float)
    if not len(v):
        return None
    return dict(mean=float(v.mean()), sd=float(v.std(ddof=1)) if len(v) > 1 else 0.0,
                p95=float(np.percentile(v, 95)), n=int(len(v)))


# ------------------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--claim", default="gd3_q14", choices=CLAIMS)
    ap.add_argument("--perms", type=int, default=200)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=8)
    args = ap.parse_args()
    c = CLAIMS[args.claim]
    t0 = time.time()

    df = load_people(c)
    themes = [t for t in df["theme"].value_counts().index if t != "other"] + (["other"] if (df["theme"] == "other").any() else [])
    print(f"{len(df)} people with a vote and an explanation; {df['theme'].notna().sum()} with a codeable theme; {len(themes)} themes")
    print("stance:", df["stance"].value_counts().to_dict())

    result = dict(
        claim=dict(id=args.claim, **{k: v for k, v in c.items() if k != "stance_of"}),
        method=dict(smoothing=SMOOTH, min_theme_n=MIN_THEME, dropped_theme=UNINFORMATIVE, n_perm=args.perms, seed=args.seed,
                    beta="number of people each table was estimated from", units="bits x people (total excess code length)",
                    solver="pdg.alg.interior_pt.cvx_opt_joint / CLARABEL", label_rule=dict(
                        deep="reason-level bits <= null 95th percentile AND power check passes",
                        underpowered="reason-level bits <= null 95th percentile, power check fails",
                        shallow="reason-level bits > null 95th percentile: same vote, different reasons")),
        stances=STANCES, themes=themes,
        theme_counts={t: {s: int(((df["theme"] == t) & (df["stance"] == s)).sum()) for s in STANCES} for t in themes},
        theme_raw_members={t: sorted(df.loc[df["theme"] == t, "theme_raw"].unique().tolist()) for t in themes},
        answers=[{k: (None if isinstance(v, float) and np.isnan(v) else v) for k, v in
                  dict(text=r.text_en, stance=r.stance, theme=r.theme, theme_raw=r.theme_raw, country=r.country, age=r.age,
                       gender=r.gender, ai_feeling=r.ai_feeling).items()} for r in df.itertuples()],
        dims={},
    )

    # "none": the whole population as one group, consistent by construction.
    df["group"] = "everyone"
    whole = dim_numbers(df, themes, ["everyone"])
    result["dims"]["none"] = dict(label="No groups", groups=["everyone"], tables=whole["tables"], pairs={}, joint=whole["joint"])

    groups = {}
    for dim, d in DIMS.items():
        df["group"] = group_of(df, dim)
        order = df["group"].value_counts()
        groups[dim] = [g for g in order.index if g != d["other"]] + ([d["other"]] if d["other"] in order.index else [])
        r = dim_numbers(df, themes, groups[dim])
        result["dims"][dim] = dict(label=d["label"], groups=groups[dim], n={g: int(order[g]) for g in groups[dim]}, **r)
        print(f"{dim}: groups {dict(order)}; joint {r['joint']['bits']:.1f} bits")

    # Null: permute group labels, recompute everything, per dimension.
    _CTX.update(df=df.drop(columns="group"), themes=themes, groups=groups)
    jobs = [(dim, args.seed * 100000 + i) for dim in DIMS for i in range(args.perms)]
    print(f"null: {len(jobs)} permutations on {args.jobs} processes…", flush=True)
    with get_context("fork").Pool(args.jobs) as pool:
        perms = pool.map(_perm_job, jobs, chunksize=4)
    for dim in DIMS:
        D = result["dims"][dim]
        runs = [p for d_, p in perms if d_ == dim]
        D["joint"]["null"] = null_summary([r["joint"] for r in runs])
        for key, pr in D["pairs"].items():
            pr["null"] = dict(
                vote=null_summary([r["pairs"][key]["vote"] for r in runs]),
                combined=null_summary([r["pairs"][key]["combined"] for r in runs]),
                reason={s: null_summary([r["pairs"][key]["reason"][s] for r in runs]) for s in STANCES})

    # Effect sizes, power check, labels.
    cells = []
    for dim in DIMS:
        D = result["dims"][dim]
        for key, pr in D["pairs"].items():
            a, b = key.split("|")
            for si, s in enumerate(STANCES):
                n = sum(D["tables"][a]["cR"][si]) + sum(D["tables"][b]["cR"][si])
                bits = pr["reason"][s]
                cells.append((dim, key, s, n, bits / n if bits is not None and n else None))
    for dim, key, s, n, eff in cells:
        pr = result["dims"][dim]["pairs"][key]
        others = [e for d_, k_, s_, n_, e in cells if (d_, k_, s_) != (dim, key, s) and e is not None]
        med = float(np.median(others)) if others else None
        null = pr["null"]["reason"][s]
        bits = pr["reason"][s]
        na = sum(result["dims"][dim]["tables"][key.split("|")[0]]["cR"][STANCES.index(s)])
        nb = sum(result["dims"][dim]["tables"][key.split("|")[1]]["cR"][STANCES.index(s)])
        power = dict(median_effect_bits_per_person=med, threshold_bits=(med * n) if med is not None else None,
                     passes=bool(med is not None and null is not None and med * n > null["p95"]))
        if bits is None or null is None:
            label = "no data"
        elif bits > null["p95"]:
            label = "shallow"
        elif power["passes"]:
            label = "deep"
        else:
            label = "underpowered"
        pr.setdefault("cells", {})[s] = dict(bits=bits, bits_per_person=eff, n=[int(na), int(nb)], null=null, power=power, label=label)
        pr.setdefault("vote_cell", dict(bits=pr["vote"], n=[result["dims"][dim]["tables"][key.split("|")[0]]["nS"], result["dims"][dim]["tables"][key.split("|")[1]]["nS"]],
                                        null=pr["null"]["vote"], above_null=bool(pr["vote"] > pr["null"]["vote"]["p95"])))

    out = DATA / f"pdg_{args.claim}.json"
    out.write_text(json.dumps(result, indent=1, ensure_ascii=False))
    print(f"wrote {out} in {time.time() - t0:.0f}s")
    for dim in DIMS:
        print(f"== {dim}")
        for key, pr in result["dims"][dim]["pairs"].items():
            v = pr["vote_cell"]
            print(f"  {key:40s} vote {v['bits']:6.1f} (null95 {v['null']['p95']:5.1f}){' *' if v['above_null'] else '  '} | " +
                  " | ".join(f"{s}: {c['bits']:6.1f}/{c['null']['p95']:5.1f} {c['label']}" if c['bits'] is not None else f"{s}: -" for s, c in pr["cells"].items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
