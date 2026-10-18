"""Timing harness for api.x.ai (run on VPS under hermes venv python). Never prints tokens."""
import sys, os, json, time, ssl, socket, http.client, uuid, statistics
HERMES_REPO = "/usr/local/lib/hermes-agent"
sys.path.insert(0, HERMES_REPO)
from tools.xai_http import resolve_xai_http_credentials, hermes_xai_user_agent
HOST = "api.x.ai"

def token():
    c = resolve_xai_http_credentials()
    assert c.get("provider") == "xai-oauth", c.get("provider")
    return c["api_key"]

class Conn:
    """one https connection with per-phase timings"""
    def __init__(self):
        t0 = time.perf_counter()
        ai = socket.getaddrinfo(HOST, 443, socket.AF_INET, socket.SOCK_STREAM)[0]
        self.t_dns = time.perf_counter() - t0
        t1 = time.perf_counter()
        self.sock = socket.create_connection(ai[4], timeout=60)
        self.t_tcp = time.perf_counter() - t1
        t2 = time.perf_counter()
        ctx = ssl.create_default_context()
        self.ss = ctx.wrap_socket(self.sock, server_hostname=HOST)
        self.t_tls = time.perf_counter() - t2
        self.h = http.client.HTTPSConnection(HOST, timeout=120)
        self.h.sock = self.ss
    def req(self, method, path, headers, body, stream=False):
        t0 = time.perf_counter()
        self.h.request(method, path, body=body, headers=headers)
        t_sent = time.perf_counter() - t0
        r = self.h.getresponse()
        ttfb = time.perf_counter() - t0
        first_tok = None; chunks = []
        if stream:
            buf = b""
            while True:
                line = r.readline()
                if not line: break
                chunks.append(line)
                if first_tok is None and b'"response.output_text.delta"' in line or (first_tok is None and b"output_text.delta" in line):
                    first_tok = time.perf_counter() - t0
            data = b"".join(chunks)
        else:
            data = r.read()
        total = time.perf_counter() - t0
        return dict(status=r.status, sent=t_sent, ttfb=ttfb, first_tok=first_tok, total=total, data=data, hdr=dict(r.getheaders()))

def multipart(fields, fname, ctype, audio):
    b = "----b" + uuid.uuid4().hex
    out = []
    for k, v in fields:
        out.append(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    out.append(f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{fname}"\r\nContent-Type: {ctype}\r\n\r\n'.encode())
    out.append(audio); out.append(f"\r\n--{b}--\r\n".encode())
    return b"".join(out), f"multipart/form-data; boundary={b}"

def H(tok, extra=None):
    h = {"Authorization": "Bearer " + tok, "User-Agent": hermes_xai_user_agent(), "Accept": "*/*"}
    h.update(extra or {}); return h

def pct(xs, p):
    xs = sorted(xs); k = (len(xs) - 1) * p; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)
