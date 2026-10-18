from xb import *
tok = token()
res = {}
def stt(c, name, ext, ctype, fmt="true", model="grok-voice-transcribe-2.0"):
    audio = open(f"/tmp/a_{name}.{ext}", "rb").read()
    body, ct = multipart([("model", model), ("format", fmt), ("language", "ru")], f"recording.{ext}", ctype, audio)
    r = c.req("POST", "/v1/stt", H(tok, {"Content-Type": ct}), body)
    txt = ""
    try: txt = json.loads(r["data"]).get("text", "")
    except Exception: txt = r["data"][:100].decode("utf8", "ignore")
    return r, txt
rows = []
for name in ("tiny", "short", "mid"):
    for ext, ct in (("m4a", "audio/mp4"), ("webm", "audio/webm")):
        for fmt in ("true",):
            tt = []; tb = []
            for i in range(5):
                c = Conn()  # cold: new TCP+TLS each
                r, txt = stt(c, name, ext, ct, fmt)
                tt.append(r["total"]); tb.append(r["ttfb"])
                if r["status"] != 200: print("ERR", r["status"], txt); break
            if tt: rows.append((name, ext, "cold", fmt, tt))
    # warm connection reuse
    c = Conn(); tt = []
    for i in range(5):
        r, txt = stt(c, name, "m4a", "audio/mp4"); tt.append(r["total"])
    rows.append((name, "m4a", "warm", "true", tt))
    print(name, "text:", txt)
for name, ext, mode, fmt, tt in rows:
    print(f"STT {name:6s} {ext:5s} {mode:5s} format={fmt}: n={len(tt)} min {min(tt):.2f} p50 {pct(tt,.5):.2f} max {max(tt):.2f} s  all={[round(x,2) for x in tt]}")
# format=false effect
c = Conn(); tt=[]
for i in range(4):
    r, txt = stt(c, "short", "m4a", "audio/mp4", fmt="false"); tt.append(r["total"])
print("STT short m4a warm format=false", [round(x,2) for x in tt])
