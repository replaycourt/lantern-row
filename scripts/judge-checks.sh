#!/usr/bin/env bash
# The five read-only checks from JUDGE.md, each printed as PASS or FAIL.
#
#   scripts/judge-checks.sh [--rpc <url>]
#
# Needs bash, curl and python3 (for decoding the RPC's JSON). Works on macOS and Linux and sends no
# transaction: every call is a view (`query`) on the public NEAR testnet RPC. Exit code: the number
# of checks that failed (0 when all pass).

set -u

RPC=${RPC:-https://test.rpc.fastnear.com}
if [ "${1:-}" = "--rpc" ] && [ -n "${2:-}" ]; then RPC=$2; fi
CONTRACT=lantern-row.testnet
GAS_ACCOUNT=lantern-row-gas.testnet
HERE=$(cd "$(dirname "$0")" && pwd)
EXPECTED_HASH=$(tr -d '[:space:]' <"$HERE/../contract/WASM_SHA256")

FAILED=0
FALLBACK_RPC=${FALLBACK_RPC:-https://near-testnet.drpc.org}
# --fail keeps an HTTP error page (FastNEAR answers 429 to a quick burst of calls) out of the output,
# so a retry cannot append a second answer to the first; when the RPC keeps refusing, the fallback
# answers instead.
query() { # $1: JSON params of a `query` call
  local body="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":$1}"
  curl -sf --max-time 20 --retry 3 --retry-delay 2 "$RPC" -H 'Content-Type: application/json' -d "$body" ||
    curl -sf --max-time 20 --retry 2 --retry-delay 2 "$FALLBACK_RPC" -H 'Content-Type: application/json' -d "$body"
}
view() { # $1: method, $2: base64 of the JSON args
  query "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"$1\",\"args_base64\":\"$2\"}"
}
# Reads the RPC answer on stdin and runs the python code in $1 on it, with `r` the result object and
# `v` a view's decoded JSON; the code sets `out`, which is printed. Any error prints "error: ...".
check() {
  python3 -I -c '
import json, sys, collections
try:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("no answer from the RPC")
    r = json.loads(raw)["result"]
    v = json.loads(bytes(r["result"]).decode()) if "result" in r else None
    out = None
    exec(sys.argv[1])
    print(out)
except Exception as e:
    print("error: %s" % (e,))
' "$1"
}
report() { # $1: name, $2: what was seen, $3: what passes
  if [ "$2" = "$3" ]; then
    printf 'PASS  %s\n' "$1"
  else
    printf 'FAIL  %s\n      expected: %s\n      got:      %s\n' "$1" "$3" "$2"
    FAILED=$((FAILED + 1))
  fi
}

echo "Lantern Row: read-only checks against $RPC"

# 1. The game contract has no access keys: nobody can redeploy it or act as it.
got=$(query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" | check 'out = len(r["keys"])')
report "1. $CONTRACT has no access keys" "$got" "0"

# 2. Coin is never created or destroyed: audit() counts the founding million.
got=$(view audit e30= | check 'out = "%s %s" % (v["founding"], v["total"])')
report "2. audit(): founding 1000000 = total 1000000" "$got" "1000000 1000000"

# 3. The deployed code is the wasm this repository records: the chain's code hash equals
#    contract/WASM_SHA256. That this hash is the build of the source is shown by a rebuild
#    (contract/build.sh --check, contract/compare-wasm.py), not by this check.
got=$(query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" | check '
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = 0
for c in r["code_hash"]:
    n = n * 58 + B58.index(c)
out = n.to_bytes(32, "big").hex()')
report "3. code hash on chain = contract/WASM_SHA256" "$got" "$EXPECTED_HASH"

# 4. A stall is an NFT that holds its own coin and goods (token 1 is the merchant The Quiet Kettle).
got=$(view nft_token eyJ0b2tlbl9pZCI6IjEifQ== | check '
m = v["metadata"]
d = m["description"].lower()
out = m["title"] + (" | holds money and goods" if "money" in d and "goods" in d else " | " + d)')
report "4. nft_token(1) is a stall holding its own coin and goods" "$got" "Stall 1: The Quiet Kettle | holds money and goods"

# 5. The relay keys that pay players' gas can only call act and advance_night on the game; one
#    full-access key, not in the repository, refills them.
got=$(query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$GAS_ACCOUNT\"}" | check '
def kind(p):
    if p == "FullAccess":
        return "full access"
    f = p["FunctionCall"]
    return f["receiver_id"] + " " + ",".join(sorted(f["method_names"]))
kinds = collections.Counter(kind(k["access_key"]["permission"]) for k in r["keys"])
relay = kinds.pop("lantern-row.testnet act,advance_night", 0)
full = kinds.pop("full access", 0)
out = "unexpected keys: %s" % dict(kinds) if kinds else "%s relay keys (act, advance_night only), %d full access" % ("some" if relay else "no", full)')
report "5. gas keys only call act and advance_night" "$got" "some relay keys (act, advance_night only), 1 full access"

if [ "$FAILED" -eq 0 ]; then echo "All 5 checks passed."; else echo "$FAILED of 5 checks failed."; fi
exit "$FAILED"
