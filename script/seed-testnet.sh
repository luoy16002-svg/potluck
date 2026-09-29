#!/usr/bin/env bash
# Seeds a testnet deployment with a completed circle (for the savings score) and a live auction circle.
# Keys come from .env (DEPLOYER_KEY, DEMO_KEYS); nothing secret is printed.
set -e
. ./.env
CHAIN=${CHAIN:-46630}; RPC=${RPC:-https://rpc.testnet.chain.robinhood.com/rpc}; ROUND=${ROUND:-420}
D=deployments/$CHAIN.json
F=$(python -c "import json;print(json.load(open('$D'))['factory'])")
U=$(python -c "import json;print(json.load(open('$D'))['usdg'])")
IFS=',' read -ra DK <<< "$DEMO_KEYS"; K=($DEPLOYER_KEY "${DK[@]}")
# The public RPC sometimes answers a sent transaction with a null receipt; treat that as sent (it was mined),
# and only retry real transport errors, so a retry never re-sends an action that already happened.
tx() { for try in 1 2 3; do out=$(cast send --rpc-url $RPC --private-key "$1" "${@:2}" 2>&1 >/dev/null) && return 0; echo "$out" | grep -q "null response" && { sleep 3; return 0; }; sleep 3; done; echo "FAILED: ${@:2}"; exit 1; }
latest() { cast call --rpc-url $RPC $F "latestCircles(uint256)(address[])" 1 | tr -d '[]'; }
MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935
CFG_T="(address,uint128,uint128,uint8,uint32,uint32,uint16,uint16,uint8)"
cfg() { echo "($U,$1,$2,$3,$4,86400,$5,$6,$7)"; }
if [ "$SKIP_FAUCET" != 1 ]; then for k in "${K[@]}"; do tx $k $U "faucet()"; done; echo "faucet done"; fi
join_all() { for i in $2; do tx ${K[$i]} $U "approve(address,uint256)" $1 $MAX; tx ${K[$i]} $1 "join()"; done; }

if [ "$SKIP_A" != 1 ]; then
tx ${K[0]} $F "createCircle(string,$CFG_T)" "Studio rent pool" "$(cfg 50000000 50000000 3 60 2000 0 0)"
A=$(latest); join_all $A "0 1 2"
for r in 1 2 3; do for i in 0 1 2; do tx ${K[$i]} $A "contribute()"; done; tx ${K[1]} $A "settleRound()"; done
echo "completed circle $A"
fi

tx ${K[1]} $F "createCircle(string,$CFG_T)" "Friday lunch circle" "$(cfg 100000000 100000000 5 $ROUND 2000 1000 1)"
B=$(latest); join_all $B "0 1 2 3 4"
for i in 0 1 3 4; do tx ${K[$i]} $B "contribute()"; done
tx ${K[4]} $B "bid(uint128)" 10000000
echo "live auction circle $B (member 2 has not paid yet; member 4 bid 10)"
