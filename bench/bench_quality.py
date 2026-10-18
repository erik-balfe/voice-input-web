from bench_refine import *
S = json.load(open("/tmp/samples.json"))
TUNED = open("/tmp/tuned_prompt.txt").read().strip()
cfgs = [("grok-4.7","low","cur",CUR),("grok-4.3","none","cur",CUR),("grok-4.3","none","tuned",TUNED),("grok-4.20-0309-non-reasoning",None,"cur",CUR),("grok-4.20-0309-non-reasoning",None,"tuned",TUNED),("grok-4.7","low","tuned",TUNED)]
c = Conn(); out = {}
for model, eff, pn, pr in cfgs:
    key = f"{model}|{eff}|{pn}"; out[key] = []
    for s in S:
        r, o, us = call(c, model, eff, pr, s["raw"], False)
        out[key].append({"id": s["id"], "ms": round(r["total"]*1000), "out": o})
json.dump(out, open("/tmp/quality.json", "w"), ensure_ascii=False, indent=1)
print("done")
