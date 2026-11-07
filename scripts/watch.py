#!/usr/bin/env python3
"""The hourly watchdog of the live Lantern Row demo (run by .github/workflows/watch.yml).

    python3 scripts/watch.py

Read-only: every call is a view on the public NEAR testnet RPC or a GET on the GitHub API, and it
needs nothing but python3, bash and curl (for scripts/judge-checks.sh). It checks
  - the read-only checks of scripts/judge-checks.sh (no access keys on the contract, code hash =
    contract/WASM_SHA256, audit, stall NFT, relay key permissions),
  - the gas account's spendable balance and the relay keys' allowance, with the days they last,
  - that nights keep ending: the last night ended recently (world()),
  - that the Town workflow (house bots and keeper) is running or has just finished a run.
It prints a table (also into the job summary), one ::error:: line per problem and one ::warning::
line when the gas would run out before judging ends, and exits 1 on any problem. The thresholds come from the environment; the defaults are the values in watch.yml.
"""
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONTRACT = "lantern-row.testnet"
GAS_ACCOUNT = "lantern-row-gas.testnet"
BOTS_WORKFLOW = "town.yml"
NIGHT_MS = 20_000  # one night, as in contract/src/config.rs
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def setting(name, default):
    return os.environ.get(name) or default


RPCS = [setting("RPC", "https://test.rpc.fastnear.com"), setting("RPC_FALLBACK", "https://near-testnet.drpc.org")]
REPO = setting("GITHUB_REPOSITORY", "replaycourt/lantern-row")
JUDGING_ENDS = setting("JUDGING_ENDS", "2026-11-25")
MIN_GAS_NEAR = float(setting("MIN_GAS_NEAR", "5"))
MIN_ALLOWANCE_NEAR = float(setting("MIN_ALLOWANCE_NEAR", "5"))
BURN_NEAR_PER_DAY = float(setting("BURN_NEAR_PER_DAY", "0.5"))
BOTS_FLOOR_NEAR = float(setting("BOTS_FLOOR_NEAR", "3"))
MAX_NIGHT_AGE_MIN = float(setting("MAX_NIGHT_AGE_MIN", "30"))
MAX_BOTS_IDLE_MIN = float(setting("MAX_BOTS_IDLE_MIN", "90"))

NEAR = 10**24
STORAGE_PER_BYTE = 10**19  # yoctoNEAR the protocol locks per byte of account storage
LOOKBACK_BLOCKS = 120_000  # about 20 hours of testnet blocks: the burn rate is measured over these
NOW = time.time()
rows = []  # (check, "ok" | "warning" | "FAIL", details)


def report(check, ok, details, warning=False):
    """Adds a row: ok, a warning (shown, but the job still passes) or a failure."""
    rows.append((check, ("warning" if warning else "ok") if ok else "FAIL", details))


def http_json(url, body=None, headers=None):
    head = {"User-Agent": "lantern-row-watch", "Content-Type": "application/json"}
    head.update(headers or {})
    data = None if body is None else json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data, head), timeout=20) as f:
            return json.load(f)
    except urllib.error.HTTPError as e:
        raise RuntimeError("HTTP %d from %s" % (e.code, url))


def rpc(method, params):
    """Asks the first RPC, then the fallback; returns the result or raises the last error."""
    err = None
    for url in RPCS:
        try:
            ans = http_json(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            if "error" in ans:
                raise RuntimeError(json.dumps(ans["error"])[:200])
            if isinstance(ans["result"], dict) and "error" in ans["result"]:
                raise RuntimeError(str(ans["result"]["error"])[:200])
            return ans["result"]
        except Exception as e:  # noqa: BLE001 -- any failure moves on to the fallback
            err = "%s: %s" % (url, e)
    raise RuntimeError(err)


def query(request_type, account, at=None, **extra):
    params = dict(at or {"finality": "final"}, request_type=request_type, account_id=account, **extra)
    return rpc("query", params)


def view(method):
    r = query("call_function", CONTRACT, method_name=method, args_base64="e30=")
    return json.loads(bytes(r["result"]).decode())


def judge_checks():
    """Runs scripts/judge-checks.sh (on the fallback RPC too if the first run fails) and reports
    each of its checks."""
    best = None
    for url in RPCS:
        run = subprocess.run(["bash", os.path.join(ROOT, "scripts", "judge-checks.sh"), "--rpc", url],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True,
                             timeout=300)
        if best is None or run.returncode < best.returncode:
            best = run
        if run.returncode == 0:
            break
    lines = best.stdout.splitlines()
    seen = 0
    for i, line in enumerate(lines):
        if line.startswith(("PASS  ", "FAIL  ")):
            seen += 1
            got = [x.split("got:", 1)[1].strip() for x in lines[i + 1:i + 3] if "got:" in x]
            want = [x.split("expected:", 1)[1].strip() for x in lines[i + 1:i + 3] if "expected:" in x]
            ok = line.startswith("PASS")
            report("judge check " + line[6:], ok, "as JUDGE.md says" if ok else
                   "expected %s, got %s" % (want[0] if want else "?", got[0] if got else "?"))
    if not seen:
        report("scripts/judge-checks.sh", False, "no result (exit %d): %s" % (best.returncode, best.stdout[-200:]))


def burn_per_day(head, amount_now):
    """NEAR per day the gas account spent over the last ~20 hours, or None when the RPC no longer
    holds that block or the account was topped up in between."""
    for height in range(head["height"] - LOOKBACK_BLOCKS, head["height"] - LOOKBACK_BLOCKS - 3, -1):
        try:  # a height can be skipped: try the next lower one
            old = rpc("block", {"block_id": height})["header"]
            then = int(query("view_account", GAS_ACCOUNT, {"block_id": old["hash"]})["amount"])
        except Exception:  # noqa: BLE001
            continue
        days = (head["timestamp"] - old["timestamp"]) / 86400e9
        spent = (then - amount_now) / NEAR
        return spent / days if spent > 0 and days > 0.1 else None
    return None


def gas():
    head = rpc("block", {"finality": "final"})["header"]
    at = {"block_id": head["hash"]}
    account = query("view_account", GAS_ACCOUNT, at)
    spendable = (int(account["amount"]) - account["storage_usage"] * STORAGE_PER_BYTE) / NEAR
    relay = [k["access_key"]["permission"]["FunctionCall"] for k in query("view_access_key_list", GAS_ACCOUNT, at)["keys"]
             if k["access_key"]["permission"] != "FullAccess"
             and k["access_key"]["permission"]["FunctionCall"]["receiver_id"] == CONTRACT]
    allowance = sum(int(f["allowance"]) for f in relay if f.get("allowance") is not None) / NEAR
    if any(f.get("allowance") is None for f in relay):
        allowance = float("inf")

    burn = burn_per_day(head, int(account["amount"]))
    rate = ("%.2f NEAR/day over the last 20 h" % burn) if burn else ("%.2f NEAR/day assumed" % BURN_NEAR_PER_DAY)
    burn = burn or BURN_NEAR_PER_DAY
    end = datetime.datetime.strptime(JUDGING_ENDS, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
    days_to_end = (end.timestamp() + 86400 - NOW) / 86400  # until the last day of judging is over

    def check(name, near, minimum, what, remedy, floor=0.0):
        days = max(near - floor, 0) / burn
        until = datetime.datetime.fromtimestamp(NOW + min(days, 3650) * 86400, datetime.timezone.utc)
        details = "%s %.2f NEAR (min %g), about %.0f days%s at %s, until %s" % (
            what, near, minimum, days, " until the house bots' floor of %g NEAR" % floor if floor else "", rate,
            until.strftime("%Y-%m-%d"))
        if near < minimum:
            details += "; below the minimum: " + remedy
        elif days < days_to_end:
            details += "; runs out before judging ends on %s: %s" % (JUDGING_ENDS, remedy)
        report(name, near >= minimum, details, warning=days < days_to_end)

    check("gas account balance", spendable, MIN_GAS_NEAR, "%s can spend" % GAS_ACCOUNT,
          "send testnet NEAR to " + GAS_ACCOUNT, BOTS_FLOOR_NEAR)
    check("relay key allowance", allowance, MIN_ALLOWANCE_NEAR, "%d relay keys for %s have" % (len(relay), CONTRACT),
          "add relay keys with scripts/setup-gas-pool.mjs")

def nights():
    w = view("world")
    age = (w["now_ms"] - (w["ends_ms"] - NIGHT_MS)) / 60000  # the open night began when the last one ended
    report("nights end", age <= MAX_NIGHT_AGE_MIN,
           "night %d open; the last night ended %.1f min ago (max %g); due now: %s"
           % (w["night"], age, MAX_NIGHT_AGE_MIN, "yes" if w["due"] else "no"))


def bots():
    def ts(text):
        return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()

    headers = {"Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    runs = http_json("https://api.github.com/repos/%s/actions/workflows/%s/runs?per_page=10" % (REPO, BOTS_WORKFLOW),
                     headers=headers)["workflow_runs"]
    running = [r for r in runs if r["status"] == "in_progress"]
    waiting = [r for r in runs if r["status"] in ("queued", "pending", "waiting", "requested")]
    done = sorted((r for r in runs if r["status"] == "completed"), key=lambda r: r["updated_at"], reverse=True)
    idle = (NOW - ts(done[0]["updated_at"])) / 60 if done else float("inf")
    ended = ("the last one (#%d) ended %.0f min ago, %s" % (done[0]["run_number"], idle, done[0]["conclusion"])
             if done else "it has never run")
    name = "%s (bots, keeper)" % BOTS_WORKFLOW
    if running:
        report(name, True, "run #%d in progress" % running[0]["run_number"])
    elif waiting and idle <= MAX_BOTS_IDLE_MIN:
        report(name, True, "run #%d about to start; %s" % (waiting[0]["run_number"], ended))
    else:
        ok = idle <= MAX_BOTS_IDLE_MIN and done[0]["conclusion"] == "success"
        report(name, ok, "no run in progress; %s (max %g min idle)" % (ended, MAX_BOTS_IDLE_MIN))


def main():
    for check, step in (("judge checks", judge_checks), ("gas", gas), ("world()", nights),
                        ("bots workflow", bots)):
        try:
            step()
        except Exception as e:  # noqa: BLE001 -- a check that cannot run is a problem too
            report(check, False, "could not check: %s" % e)

    when = datetime.datetime.fromtimestamp(NOW, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    table = ["### Lantern Row watchdog, %s" % when, "", "| Check | Result | Details |", "|---|---|---|"]
    table += ["| %s | %s | %s |" % (c, r, d.replace("|", "/")) for c, r, d in rows]
    print("\n".join(table))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write("\n".join(table) + "\n")
    for check, result, details in rows:
        if result != "ok":
            print("::%s::%s: %s" % ("error" if result == "FAIL" else "warning", check, details.replace("%", "%25")))
    problems = [c for c, r, d in rows if r == "FAIL"]
    warnings = len([c for c, r, d in rows if r == "warning"])
    print("%d of %d checks failed." % (len(problems), len(rows)) if problems else
          "All %d checks passed%s." % (len(rows), " (%d with a warning)" % warnings if warnings else ""))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
