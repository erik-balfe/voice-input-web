import os, sys, subprocess
sys.path.insert(0, "/usr/local/lib/hermes-agent")
from tools.xai_http import resolve_xai_http_credentials
c = resolve_xai_http_credentials(); assert c.get("provider") == "xai-oauth"
env = dict(os.environ, XAI_TOK=c["api_key"], N=sys.argv[1] if len(sys.argv) > 1 else "5")
sys.exit(subprocess.call(["node", "real.mjs"], cwd="/tmp/rt", env=env))
