import json, sys, statistics as st
D = {d["id"]: d for d in json.load(open("synth.json"))}
rows = [json.loads(l) for l in open("matrix.jsonl")]
J = json.load(open("judge.json")) if len(sys.argv) < 2 or sys.argv[1] != "nojudge" else {}
def pct(xs, p):
    xs = sorted(xs); k = (len(xs)-1)*p; f = int(k); c = min(f+1, len(xs)-1); return xs[f] + (xs[c]-xs[f])*(k-f)
groups = {}
for r in rows:
    groups.setdefault((r["model"], r["effort"], r["prompt"]), []).append(r)
out = []
for k, rs in groups.items():
    ok = [r for r in rs if r.get("status") == 200]
    errs = len(rs) - len(ok)
    if not ok:
        out.append(dict(cfg=k, n=0, errs=errs, err=(rs[0].get("err") or "")[:80])); continue
    ms = [r["ms"] for r in ok]
    row = dict(cfg=k, n=len(ok), errs=errs, p50=pct(ms,.5), p95=pct(ms,.95), mx=max(ms),
               reas=st.mean([r.get("reas") or 0 for r in ok]), outt=st.mean([r.get("outt") or 0 for r in ok]), inp=st.mean([r.get("inp") or 0 for r in ok]))
    short = [r["ms"] for r in ok if D[r["id"]]["kind"] == "short"]; long_ = [r["ms"] for r in ok if D[r["id"]]["kind"] in ("long",)]
    row["short50"] = pct(short,.5) if short else None; row["long50"] = pct(long_,.5) if long_ else None
    sc = [J.get(r["id"] + "||" + r["out"]) for r in ok]; sc = [s for s in sc if s]
    if sc:
        m = st.mean(s["meaning"] for s in sc); c = st.mean(s["cleanup"] for s in sc); y = st.mean(s["style"] for s in sc)
        row.update(meaning=m, cleanup=c, style=y, q=0.5*m+0.3*c+0.2*y, fails=sum(1 for s in sc if s["meaning"] <= 2), nj=len(sc))
    out.append(row)
def f(x, d=2): return "–" if x is None else f"{x:.{d}f}"
print("| модель | effort | промпт | n | p50 с | p95 с | коротк. p50 | длинн. p50 | reasoning ток. | out ток. | in ток. | смысл | чистка | стиль | итог | сбои смысла |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for r in out:
    m, e, p = r["cfg"]
    if not r["n"]: print(f"| {m} | {e} | {p} | 0 | ошибки: {r['err']} |"); continue
    print(f"| {m} | {e or 'default'} | {p} | {r['n']} | {r['p50']/1000:.2f} | {r['p95']/1000:.2f} | {f(r['short50']/1000 if r['short50'] else None)} | {f(r['long50']/1000 if r['long50'] else None)} | {r['reas']:.0f} | {r['outt']:.0f} | {r['inp']:.0f} | {f(r.get('meaning'))} | {f(r.get('cleanup'))} | {f(r.get('style'))} | {f(r.get('q'))} | {r.get('fails','–')} |")
json.dump([{**r, "cfg": list(r["cfg"])} for r in out], open("agg.json", "w"), ensure_ascii=False)
