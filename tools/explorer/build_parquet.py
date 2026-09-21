#!/usr/bin/env python3
"""ETL: Global Dialogues CSVs -> parquet tables for the Mosaic explorer.

    python tools/explorer/build_parquet.py --data ../global-dialogues/Data --rounds GD9

Tables (all rounds stacked, `round` column): participants, questions, poll_options,
poll_answers, statements, votes, pairwise. See docs/plan_mosaic_explorer.md section 4 in the
global-dialogues repo. Writes build_report.json next to the parquet files and exits non-zero
when a hard check fails.

Question identity comes from `aggregate_standardized.csv` (UUID, type, survey order, option
order): `question_id_mapping.csv` repeats UUIDs for questions sharing a text prefix and
omits Rank questions, so it is not used. No rates are read from the aggregate except the
imputed `All` agreement rate.
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
from collections import Counter, OrderedDict, defaultdict
from pathlib import Path

import pandas as pd

csv.field_size_limit(10**9)

HERE = Path(__file__).resolve().parent
ROUND_ORDER = {"GD1": 10, "GD2": 20, "GD3": 30, "GD4": 40, "GD5": 50, "GD6": 60,
               "GD6UK": 65, "GD7": 70, "GD8": 80, "GD9": 90}
# Known per-round counts from Data/README.md section 4:
# (participants, ask-opinion statements, binary votes, pairwise)
EXPECTED = {
    "GD1": (1294, 19669, 97964, 97851), "GD2": (1120, 20869, 103898, 103292),
    "GD3": (986, 14188, 70690, 70626), "GD4": (1058, 6107, 30409, 30349),
    "GD5": (1065, 9134, 45494, 45437), "GD6": (1053, 3069, 15309, 15298),
    "GD6UK": (1043, 3028, 15086, 15081), "GD7": (1033, 4008, 19974, 19922),
    "GD8": (1068, 7200, 35809, 35764), "GD9": (1103, 6103, 30388, 29861),
}
# Demographic dimension -> regex on the onboarding question text.
DEMOGRAPHICS = OrderedDict([
    ("language", r"preferred language"),
    ("age", r"how old are you"),
    ("gender", r"what is your gender"),
    ("environment", r"best describes where you live"),
    ("ai_feeling", r"increased use of artificial intelligence.*makes you feel"),
    ("religion", r"religious group or faith"),
    ("country", r"country or region do you most identify"),
])
BLANK = {"", "--"}
AGE_FIX = {"<18": "Less than 18"}
COUNTRY_FIX = {"Turkey": "Türkiye"}  # label changed between rounds


class EtlError(Exception):
    pass


def clean(s: str) -> str:
    """Unescape HTML entities (&lt;18) and collapse whitespace."""
    return re.sub(r"\s+", " ", html.unescape(s or "")).strip()


def norm(s: str) -> str:
    """Loose key for matching question wording across files."""
    s = clean(s).lower().replace("…", "").replace("...", "")
    return re.sub(r"[^a-z0-9]+", "", s)


def read_csv(path: Path) -> list[list[str]]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.reader(f))


def pct(s: str):
    s = (s or "").strip().rstrip("%")
    try:
        return float(s) / 100.0
    except ValueError:
        return None


def parse_ts(series: pd.Series) -> pd.Series:
    # 'May 22, 2026 at 12:10 PM (GMT)'
    s = series.str.replace(" at ", " ", regex=False).str.replace(r"\s*\(GMT\)", "", regex=True)
    return pd.to_datetime(s, format="%B %d, %Y %I:%M %p", errors="coerce")


# --------------------------------------------------------------------------- questions

def load_aggregate(rdir: Path, rnd: str):
    """Ordered questions + poll options + per-statement rows from aggregate_standardized."""
    rows = read_csv(rdir / f"{rnd}_aggregate_standardized.csv")
    h = rows[0]
    col = {name: h.index(name) for name in
           ["Question ID", "Question Type", "Question", "Response", "OriginalResponse",
            "Sentiment", "Language", "Participant ID", "All"]}
    branch_cols = [i for i, c in enumerate(h) if re.fullmatch(r"Branch [A-Z]", c)]
    questions: "OrderedDict[str, dict]" = OrderedDict()
    text_rows = []
    for r in rows[1:]:
        qid = r[col["Question ID"]]
        q = questions.setdefault(qid, {
            "question_id": qid, "question_type": r[col["Question Type"]],
            "question_text": clean(r[col["Question"]]), "options": []})
        if q["question_type"].startswith("Poll"):
            opt = clean(r[col["Response"]])
            if opt not in q["options"]:
                q["options"].append(opt)
        elif q["question_type"].startswith("Ask"):
            rate = pct(r[col["All"]])
            if rate is None:  # branched questions report under `Branch X` instead of `All`
                rate = next((v for v in (pct(r[i]) for i in branch_cols) if v is not None), None)
            text_rows.append({
                "question_id": qid, "participant_id": r[col["Participant ID"]],
                "text_en": r[col["Response"]], "text_orig": r[col["OriginalResponse"]],
                "language": clean(r[col["Language"]]), "sentiment": clean(r[col["Sentiment"]]),
                "rate": rate})
    return questions, text_rows


def load_guide(rdir: Path, rnd: str) -> list[dict]:
    rows = read_csv(rdir / f"{rnd}_discussion_guide.csv")
    hdr = next(i for i, r in enumerate(rows) if any("Item type" in c for c in r))
    h = rows[hdr]
    ci = {"section": next(i for i, c in enumerate(h) if c.strip() == "Section"),
          "tag": next(i for i, c in enumerate(h) if c.startswith("Cross Conversation Tag")),
          "type": next(i for i, c in enumerate(h) if c.startswith("Item type")),
          "content": next(i for i, c in enumerate(h) if c.strip() == "Content"),
          "opt1": next(i for i, c in enumerate(h) if c.strip() == "Poll or Category Option 1")}
    items = []
    for r in rows[hdr + 1:]:
        r = r + [""] * (ci["opt1"] + 1 - len(r))
        typ = r[ci["type"]].strip().lower()
        if not typ or typ in ("text", "speak"):
            continue
        m = re.search(r"(\d+)", r[ci["tag"]])
        items.append({"section": clean(r[ci["section"]]), "merge_id": m.group(1) if m else None,
                      "item_type": typ, "key": norm(r[ci["content"]]),
                      "options": [clean(x) for x in r[ci["opt1"]:] if clean(x)]})
    return items


def load_codesheet(data: Path) -> list[dict]:
    path = data / "Documentation" / "INDICATOR_CODESHEET.csv"
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def build_questions(rnd, questions, guide, codesheet, report):
    # Walk the guide in order alongside the aggregate questions; identical wordings
    # (a poll asked again at the end) resolve by position.
    gi, section = 0, ""
    for q in questions.values():
        key = norm(q["question_text"])
        hit = next((j for j in range(gi, len(guide))
                    if guide[j]["key"] and (guide[j]["key"] == key or key.endswith(guide[j]["key"])
                                            or guide[j]["key"].startswith(key))), None)
        if hit is not None:
            g = guide[hit]
            gi, section = hit + 1, g["section"] or section
            q.update(merge_id=g["merge_id"], onboarding=g["item_type"].startswith("onboarding"),
                     guide_options=g["options"])
        else:
            q.update(merge_id=None, onboarding=False, guide_options=[])
        q["section"] = section or ("Onboarding" if q.get("onboarding") else "")
    for q in questions.values():
        if q["onboarding"] and not q["section"]:
            q["section"] = "Onboarding"

    text_col = next((c for c in (codesheet[0] if codesheet else {}) if "text" in c.lower()), None)
    code_by_key = {norm(c[text_col]): c for c in codesheet} if text_col else {}
    matched = set()
    out = []
    for order, q in enumerate(questions.values(), 1):
        c = code_by_key.get(norm(q["question_text"]))
        if c and c["question_code"] in matched:
            # Same wording asked again later in the round (post-treatment repeat, or a
            # different option scale): only the first asking carries the Indicator code.
            report.setdefault("indicator_repeats_ignored", []).append(c["question_code"])
            c = None
        if c:
            matched.add(c["question_code"])
        out.append({
            "round": rnd, "question_id": q["question_id"], "order_in_survey": order,
            "question_type": q["question_type"], "question_text": q["question_text"],
            "section": q["section"], "indicator_code": c["question_code"] if c else None,
            "indicator_category": c["question_category"] if c else None,
            "merge_id": q["merge_id"], "n_options": len(q["options"]) or None,
            "is_onboarding": bool(q["onboarding"]),
        })
    report["indicators_matched"] = len(matched)
    report["indicators_unmatched"] = sorted(c["question_code"] for c in codesheet
                                            if c["question_code"] not in matched)
    return out


# ------------------------------------------------------------------------ participants

def map_columns(header, questions):
    """Assign participants.csv columns to poll questions, by position and wording."""
    qlist = list(questions.values())
    keys = [norm(q["question_text"]) for q in qlist]
    single, multi = {}, defaultdict(list)  # qid -> col ; qid -> [(col, option)]
    cur = 0
    for ci, raw in enumerate(header):
        if ci < 4:
            continue
        name = clean(raw)
        if not name or name in ("Sentiment", "Categories", "Muted") or name.endswith("(%agree)") \
                or name.endswith("(English)") or name.endswith("(Original)") \
                or re.match(r"Rank \d+ - ", name):
            continue
        k = norm(name)
        found = None
        for j in range(cur, len(qlist)):
            q = qlist[j]
            if q["question_type"] == "Poll Single Select" and keys[j] == k \
                    and q["question_id"] not in single:
                found = ("s", j, None)
                break
            if q["question_type"] == "Poll Multi Select" and k.startswith(keys[j]):
                opt = next((o for o in q["options"]
                            if norm(q["question_text"] + " - " + o) == k), None)
                if opt is not None:
                    found = ("m", j, opt)
                    break
        if not found:
            continue
        kind, j, opt = found
        cur = j
        if kind == "s":
            single[qlist[j]["question_id"]] = ci
        else:
            multi[qlist[j]["question_id"]].append((ci, opt))
    return single, multi


def build_participants(rnd, rdir, data, questions, regions, report):
    rows = read_csv(rdir / f"{rnd}_participants.csv")
    header, body = rows[0], rows[1:]
    single, multi = map_columns(header, questions)

    polls = [q for q in questions.values() if q["question_type"].startswith("Poll")]
    unmapped = [q["question_text"][:80] for q in polls
                if q["question_id"] not in single and q["question_id"] not in multi]
    if unmapped:
        raise EtlError(f"{rnd}: poll questions with no participants.csv column: {unmapped}")

    demo_col = {}
    for dim, pat in DEMOGRAPHICS.items():
        q = next((q for q in questions.values() if re.search(pat, q["question_text"], re.I)
                  and q["question_id"] in single), None)
        if q is None:
            raise EtlError(f"{rnd}: demographic question not found: {dim}")
        demo_col[dim] = single[q["question_id"]]
        q["demographic"] = dim

    pri = {}
    pri_path = data.parent / "analysis_output" / rnd / "pri" / f"{rnd}_pri_scores.csv"
    if pri_path.exists():
        with open(pri_path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                try:
                    pri[r["Participant ID"]] = float(r["PRI_Score"])
                except (ValueError, KeyError):
                    pass

    people, answers, unknown_country = [], [], Counter()
    bad_values = Counter()
    for r in body:
        pid = r[2]
        p = {"round": rnd, "participant_id": pid, "sample_id": r[3]}
        for dim, ci in demo_col.items():
            v = clean(r[ci])
            p[dim] = None if v in BLANK else AGE_FIX.get(v, v)
        p["country"] = COUNTRY_FIX.get(p["country"], p["country"])
        reg = regions.get(p["country"])
        if p["country"] and not reg:
            unknown_country[p["country"]] += 1
        p["region"], p["subregion"] = reg or (None, None)
        p["pri_score"] = pri.get(pid)
        people.append(p)

        for qid, ci in single.items():
            v = clean(r[ci])
            if v in BLANK:
                continue
            v = AGE_FIX.get(v, v)
            opts = questions[qid]["options"]
            if v not in opts:
                bad_values[(questions[qid]["question_text"][:50], v)] += 1
                continue
            answers.append((rnd, pid, qid, v, opts.index(v) + 1))
        for qid, cols in multi.items():
            opts = questions[qid]["options"]
            for ci, opt in cols:
                if clean(r[ci]) not in BLANK:
                    answers.append((rnd, pid, qid, opt, opts.index(opt) + 1))

    if unknown_country:
        raise EtlError(f"{rnd}: countries missing from region_lookup.csv: {dict(unknown_country)}")
    if bad_values:
        raise EtlError(f"{rnd}: poll values not among the question's options: {dict(bad_values)}")
    report["pri_scores_joined"] = sum(p["pri_score"] is not None for p in people)
    return people, answers


def check_option_order(rnd, questions, report):
    """Option order comes from the aggregate; cross-check it against the discussion guide."""
    diffs = []
    for q in questions.values():
        if not q["question_type"].startswith("Poll"):
            continue
        if not q["options"]:
            raise EtlError(f"{rnd}: poll without options: {q['question_text'][:80]}")
        g = [o for o in q["guide_options"] if o in q["options"]]
        a = [o for o in q["options"] if o in g]
        if g and g != a:
            diffs.append(q["question_text"][:80])
    report["option_order_differs_from_guide"] = diffs


def check_respondents(rnd, rdir, answers, questions, report):
    """Respondents per poll must equal Remesh's own N per question."""
    path = rdir / f"{rnd}_segment_counts_by_question.csv"
    if not path.exists():
        return
    rows = read_csv(path)
    ai = rows[0].index("All")
    expected = {r[0]: int(float(r[ai])) for r in rows[1:] if r[ai].strip()}
    got = defaultdict(set)
    for _, pid, qid, _, _ in answers:
        got[qid].add(pid)
    bad = {questions[q]["question_text"][:60]: [len(got[q]), expected[q]]
           for q in got if q in expected and len(got[q]) != expected[q]}
    report["poll_respondent_mismatches"] = bad


# -------------------------------------------------------------------------- statements

def build_statements(rnd, rdir, questions, text_rows, report):
    vm = read_csv(rdir / f"{rnd}_verbatim_map.csv")[1:]
    binary = pd.DataFrame(read_csv(rdir / f"{rnd}_binary.csv")[1:],
                          columns=["question_id", "voter_id", "thought_id", "vote", "ts"])
    counts = binary.groupby(["thought_id", "vote"]).size().unstack(fill_value=0)

    tags, tags_by_person, tags_by_text = {}, {}, {}
    tpath = rdir / "tags" / "all_thought_labels.csv"
    if tpath.exists():
        for r in read_csv(tpath)[1:]:
            t = [clean(x) for x in r[4:] if clean(x)][:3]
            tags[(r[0], r[1], clean(r[2]))] = t
            tags_by_person.setdefault((r[0], r[1]), []).append(t)
            tags_by_text.setdefault((r[1], clean(r[2])), t)  # GD5 tags use other question UUIDs

    def tags_for(qid, pid, text):
        t = tags.get((qid, pid, clean(text)))
        if t is None:  # text drifted between exports: fall back when the author has one row
            cand = tags_by_person.get((qid, pid), [])
            t = cand[0] if len(cand) == 1 else tags_by_text.get((pid, clean(text)))
        return t

    agg, agg_by_person = {}, defaultdict(list)
    for t in text_rows:
        key = (t["question_id"], t["participant_id"], clean(t["text_en"]))
        if key not in agg:
            agg[key] = t
            agg_by_person[key[:2]].append(t)

    out, no_tags, no_agg = [], 0, 0
    seen = set()
    for qid, _qtext, pid, thought_id, text in vm:
        a = agg.get((qid, pid, clean(text)))
        if a is None and len(agg_by_person[(qid, pid)]) == 1:  # wording drifted between exports
            a = agg_by_person[(qid, pid)][0]
        if a is None:
            no_agg += 1
            a = {"text_orig": None, "language": None, "sentiment": None, "rate": None}
        t = tags_for(qid, pid, text)
        no_tags += t is None
        t = (t or []) + [None] * 3
        c = counts.loc[thought_id] if thought_id in counts.index else {}
        n_a, n_d, n_n = (int(c.get(k, 0)) for k in ("Agree", "Disagree", "Neutral"))
        out.append({
            "round": rnd, "thought_id": thought_id, "question_id": qid, "participant_id": pid,
            "text_en": text.strip(), "text_orig": a["text_orig"], "language": a["language"],
            "sentiment": a["sentiment"] or None, "tag_1": t[0], "tag_2": t[1], "tag_3": t[2],
            "n_agree": n_a, "n_disagree": n_d, "n_neutral": n_n,
            "agree_rate_raw": n_a / (n_a + n_d) if (n_a + n_d) else None,
            "agree_rate_imputed_all": a["rate"]})
        seen.add((qid, pid, clean(text)))

    # Ask Experience: no Thought ID, no votes. The aggregate repeats a response once per
    # category, so keep the first. The Prolific-ID question is dropped entirely.
    n_exp = 0
    for key, a in agg.items():
        q = questions[a["question_id"]]
        if q["question_type"] != "Ask Experience" or "prolific" in q["question_text"].lower():
            continue
        if not clean(a["text_en"]) or clean(a["text_en"]) in BLANK:
            continue
        t = (tags_for(a["question_id"], a["participant_id"], a["text_en"]) or []) + [None] * 3
        out.append({
            "round": rnd, "thought_id": None, "question_id": a["question_id"],
            "participant_id": a["participant_id"], "text_en": a["text_en"].strip(),
            "text_orig": a["text_orig"], "language": a["language"],
            "sentiment": a["sentiment"] or None, "tag_1": t[0], "tag_2": t[1], "tag_3": t[2],
            "n_agree": 0, "n_disagree": 0, "n_neutral": 0, "agree_rate_raw": None,
            "agree_rate_imputed_all": None})
        n_exp += 1

    report.update(statements_ask_opinion=len(vm), statements_ask_experience=n_exp,
                  statements_without_tags=int(no_tags), statements_without_aggregate_row=no_agg)

    binary["round"] = rnd
    binary["ts"] = parse_ts(binary["ts"])
    votes = binary[["round", "question_id", "voter_id", "thought_id", "vote", "ts"]]
    report["votes_by_type"] = {k: int(v) for k, v in votes["vote"].value_counts().items()}
    report["votes_unparsed_ts"] = int(votes["ts"].isna().sum())
    report["votes_orphan_thought"] = int((~votes["thought_id"].isin({r[3] for r in vm})).sum())

    pw = pd.DataFrame(read_csv(rdir / f"{rnd}_preference.csv")[1:],
                      columns=["question_id", "voter_id", "thought_a", "thought_b", "vote", "ts"])
    pw["round"] = rnd
    pw["ts"] = parse_ts(pw["ts"])
    pw = pw[["round", "question_id", "voter_id", "thought_a", "thought_b", "vote", "ts"]]
    return out, votes, pw


# -------------------------------------------------------------------------------- main

def build_round(rnd, data, regions, codesheet):
    rdir = data / rnd
    report = {}
    questions, text_rows = load_aggregate(rdir, rnd)
    # An Ask-Opinion question can be missing from the aggregate export (GD6UK has one);
    # keep it so its statements and votes still have a question row.
    for r in read_csv(rdir / f"{rnd}_verbatim_map.csv")[1:]:
        if r[0] not in questions:
            questions[r[0]] = {"question_id": r[0], "question_type": "Ask Opinion",
                               "question_text": clean(r[1]), "options": []}
            report.setdefault("questions_only_in_verbatim_map", []).append(clean(r[1])[:100])
    guide = load_guide(rdir, rnd)
    qrows = build_questions(rnd, questions, guide, codesheet, report)
    check_option_order(rnd, questions, report)
    people, answers = build_participants(rnd, rdir, data, questions, regions, report)
    check_respondents(rnd, rdir, answers, questions, report)
    statements, votes, pairwise = build_statements(rnd, rdir, questions, text_rows, report)

    for row in qrows:
        row["demographic"] = questions[row["question_id"]].get("demographic")
    options = [{"round": rnd, "question_id": q["question_id"], "option": o, "option_order": i}
               for q in questions.values() if q["question_type"].startswith("Poll")
               for i, o in enumerate(q["options"], 1)]

    tables = {
        "participants": pd.DataFrame(people),
        "questions": pd.DataFrame(qrows),
        "poll_options": pd.DataFrame(options),
        "poll_answers": pd.DataFrame(answers, columns=["round", "participant_id", "question_id",
                                                        "option", "option_order"]),
        "statements": pd.DataFrame(statements),
        "votes": votes,
        "pairwise": pairwise,
    }
    report["rows"] = {k: len(v) for k, v in tables.items()}
    report["question_types"] = dict(Counter(q["question_type"] for q in questions.values()))

    exp = EXPECTED.get(rnd)
    if exp:
        got = (len(people), report["statements_ask_opinion"], len(votes), len(pairwise))
        names = ("participants", "statements_ask_opinion", "votes", "pairwise")
        report["expected_check"] = {n: {"got": g, "expected": e, "ok": g == e}
                                    for n, g, e in zip(names, got, exp)}
    return tables, report


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", type=Path, default=HERE.parents[2] / "global-dialogues" / "Data")
    ap.add_argument("--out", type=Path, default=HERE.parents[1] / "explorer" / "public" / "data")
    ap.add_argument("--rounds", nargs="+", default=["GD9"])
    args = ap.parse_args()

    with open(HERE / "region_lookup.csv", encoding="utf-8", newline="") as f:
        regions = {r["country"]: (r["region"], r["subregion"]) for r in csv.DictReader(f)}
    codesheet = load_codesheet(args.data)

    all_tables, report, failed = defaultdict(list), {"rounds": {}}, False
    for rnd in args.rounds:
        tables, rep = build_round(rnd, args.data, regions, codesheet)
        report["rounds"][rnd] = rep
        for name, df in tables.items():
            df.insert(1, "round_order", ROUND_ORDER.get(rnd, 999))
            all_tables[name].append(df)
        checks = rep.get("expected_check", {})
        bad = [k for k, v in checks.items() if not v["ok"]]
        if bad or rep.get("poll_respondent_mismatches"):
            failed = True
        print(f"{rnd}: {rep['rows']}  count checks: "
              f"{'OK' if not bad else 'MISMATCH ' + str(bad)}")

    args.out.mkdir(parents=True, exist_ok=True)
    for name, dfs in all_tables.items():
        df = pd.concat(dfs, ignore_index=True)
        df.to_parquet(args.out / f"{name}.parquet", index=False, compression="snappy")
    report["tables"] = {n: sum(len(d) for d in dfs) for n, dfs in all_tables.items()}
    (args.out / "build_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"wrote {len(all_tables)} tables + build_report.json to {args.out}")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except EtlError as e:
        print(f"ETL ERROR: {e}", file=sys.stderr)
        sys.exit(2)
