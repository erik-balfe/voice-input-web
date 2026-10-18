import json, sys, time
from xb import *
tok = token()
P = json.load(open("/tmp/vb/prompts.json")); D = json.load(open("/tmp/vb/synth.json"))
SUB = [d["id"] for d in D if d["id"] in ("d01","d02","d05","d09","d12","d14","d17","d19")]
# (model, effort, prompt, subset?)
CFG = []
for p in ("CUR","FAST","MIN_RU","MIN_EN","ONE"): CFG.append(("grok-4.7","low",p,p=="ONE"))
for p in ("MIN_EN",): CFG += [("grok-4.7","medium",p,True),("grok-4.7","high",p,True)]
CFG.append(("grok-4.7",None,"MIN_EN",True))  # model default effort (= high)
for e in ("none","low"):
    for p in ("CUR","FAST","MIN_RU","MIN_EN","ONE"): CFG.append(("grok-4.3",e,p,p=="ONE"))
CFG.append(("grok-4.3","medium","MIN_EN",True))
for p in ("CUR","FAST","MIN_RU","MIN_EN","ONE"): CFG.append(("grok-4.20-0309-non-reasoning",None,p,p=="ONE"))
CFG += [("grok-4.5","low","MIN_EN",False),("grok-4.6","low","MIN_EN",False),("grok-4.20-0309-reasoning",None,"MIN_EN",True),("grok-build-0.1",None,"MIN_EN",False)]
if len(sys.argv) > 1: CFG = CFG[int(sys.argv[1]):int(sys.argv[2])]
out = open("/tmp/vb/matrix.jsonl", "a")
c = Conn()
for model, eff, pn, sub in CFG:
    for d in D:
        if sub and d["id"] not in SUB: continue
        p = {"model": model, "store": False, "input": [{"role":"system","content":P[pn]},{"role":"user","content":d["raw"]}]}
        if eff: p["reasoning"] = {"effort": eff}
        try:
            r = c.req("POST", "/v1/responses", H(tok, {"Content-Type":"application/json"}), json.dumps(p))
        except Exception as e:
            c = Conn(); out.write(json.dumps({"model":model,"effort":eff,"prompt":pn,"id":d["id"],"status":0,"err":str(e)})+"\n"); out.flush(); continue
        row = {"model":model,"effort":eff,"prompt":pn,"id":d["id"],"status":r["status"],"ms":round(r["total"]*1000)}
        try:
            j = json.loads(r["data"]); u = j.get("usage") or {}
            txt = ""
            for it in j.get("output", []):
                if it.get("type") == "message":
                    for part in it.get("content", []): txt += part.get("text", "")
            row.update(out=txt.strip(), inp=u.get("input_tokens"), outt=u.get("output_tokens"), reas=(u.get("output_tokens_details") or {}).get("reasoning_tokens"), cached=(u.get("input_tokens_details") or {}).get("cached_tokens"), err=None if r["status"]==200 else r["data"][:200].decode("utf8","ignore"))
        except Exception as e:
            row["err"] = r["data"][:200].decode("utf8","ignore")
        out.write(json.dumps(row, ensure_ascii=False)+"\n"); out.flush()
    print("done", model, eff, pn, flush=True)
print("ALLDONE", flush=True)
