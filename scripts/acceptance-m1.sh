#!/usr/bin/env bash
# Milestone 1 acceptance: drives the running app over HTTP with synthetic users.
# Usage: start the app (pnpm --filter @wos/web start), then: bash scripts/acceptance-m1.sh
# Sign-up is rate limited per IP (a few per 10 s); wait ~15 s between runs.
set -euo pipefail
BASE=${BASE:-http://localhost:3000}
TMP=$(mktemp -d)
RUN=$RANDOM
H=(-H "Content-Type: application/json" -H "Origin: $BASE")

signup() { # name email jar
  curl -sS -o /dev/null -w "%{http_code}" -c "$TMP/$3" "${H[@]}" \
    -d "{\"name\":\"$1\",\"email\":\"$2\",\"password\":\"synthetic-password-123\"}" "$BASE/api/auth/sign-up/email"
}
call() { # jar method procedure json -> body
  local jar=$1 method=$2 proc=$3 input=$4
  if [ "$method" = GET ]; then
    curl -sS -b "$TMP/$jar" "${H[@]}" "$BASE/api/trpc/$proc?input=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "{\"json\":$input}")"
  else
    curl -sS -b "$TMP/$jar" "${H[@]}" -d "{\"json\":$input}" "$BASE/api/trpc/$proc"
  fi
}
field() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (expected $3, got $2)"; exit 1; fi; }

echo "== Sign up three synthetic users"
check "owner sign-up" "$(signup Owner owner$RUN@example.test a)" 200
check "staff sign-up" "$(signup Staff staff$RUN@example.test b)" 200
check "other-firm sign-up" "$(signup Other other$RUN@example.test c)" 200

echo "== Create organizations"
ORG_A=$(call a POST org.create '{"name":"Acme Tax (synthetic)"}' | field "['result']['data']['json']['orgId']")
ORG_C=$(call c POST org.create '{"name":"Other Firm (synthetic)"}' | field "['result']['data']['json']['orgId']")
echo "org A=$ORG_A  org C=$ORG_C"

echo "== Invite and list"
check "owner adds staff as member" "$(call a POST org.invite "{\"orgId\":\"$ORG_A\",\"email\":\"staff$RUN@example.test\",\"role\":\"member\"}" | field "['result']['data']['json']['userId']!=''")" True
check "org A has 2 members" "$(call a GET org.listMembers "{\"orgId\":\"$ORG_A\"}" | field "['result']['data']['json'].__len__()")" 2
check "staff sees org A in their list" "$(call b GET org.listMine 'null' | field "['result']['data']['json'][0]['orgId']")" "$ORG_A"

echo "== Authorization"
check "member cannot invite" "$(call b POST org.invite "{\"orgId\":\"$ORG_A\",\"email\":\"other$RUN@example.test\",\"role\":\"member\"}" | field "['error']['json']['data']['code']")" FORBIDDEN
check "anonymous request rejected" "$(curl -sS "${H[@]}" -d '{"json":{"name":"x"}}' "$BASE/api/trpc/org.create" | field "['error']['json']['data']['code']")" UNAUTHORIZED

echo "== Tenant isolation"
check "org C owner cannot list org A" "$(call c GET org.listMembers "{\"orgId\":\"$ORG_A\"}" | field "['error']['json']['data']['code']")" NOT_FOUND
check "org C owner cannot invite into org A" "$(call c POST org.invite "{\"orgId\":\"$ORG_A\",\"email\":\"other$RUN@example.test\",\"role\":\"owner\"}" | field "['error']['json']['data']['code']")" NOT_FOUND
check "org C owner sees only org C" "$(call c GET org.listMine 'null' | field "['result']['data']['json'].__len__()==1 and d['result']['data']['json'][0]['orgId']=='$ORG_C'")" True

echo "== Pages"
check "org page renders for owner" "$(curl -sS -o /dev/null -w '%{http_code}' -b "$TMP/a" "$BASE/orgs/$ORG_A")" 200
check "org page is 404 for other tenant" "$(curl -sS -o /dev/null -w '%{http_code}' -b "$TMP/c" "$BASE/orgs/$ORG_A")" 404
check "signed-out visitor redirected to sign-in" "$(curl -sS -o /dev/null -w '%{redirect_url}' "$BASE/orgs" | sed 's#.*/##')" sign-in

echo "ALL ACCEPTANCE CHECKS PASSED"
rm -rf "$TMP"
