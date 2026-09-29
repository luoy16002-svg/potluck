#!/usr/bin/env bash
# Seeds the local Anvil chain with demo circles (for UI work and screen recordings).
set -e
RPC=${RPC:-http://127.0.0.1:8545}
D=deployments/31337.json
F=$(python -c "import json;print(json.load(open('$D'))['factory'])")
U=$(python -c "import json;print(json.load(open('$D'))['usdg'])")
K=(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a)
tx() { cast send --rpc-url $RPC --private-key "$1" "${@:2}" >/dev/null || { echo "FAILED: ${@:2}"; exit 1; }; }
cast rpc --rpc-url $RPC evm_increaseTime 3700 >/dev/null; cast rpc --rpc-url $RPC evm_mine >/dev/null
for k in "${K[@]}"; do tx $k $U "faucet()"; done
latest() { cast call --rpc-url $RPC $F "latestCircles(uint256)(address[])" 1 | tr -d '[]'; }
cfg() { echo "($U,$1,$2,$3,$4,604800,$5,$6,$7)"; }  # contribution collateral size round bond disc mode
join_all() { for i in $(seq 0 $(($2-1))); do tx ${K[$i]} $U "approve(address,uint256)" $1 115792089237316195423570985008687907853269984665640564039457584007913129639935; tx ${K[$i]} $1 "join()"; done; }
pay_all() { for i in $(seq 0 $(($2-1))); do tx ${K[$i]} $1 "contribute()"; done; }
CFG_T="(address,uint128,uint128,uint8,uint32,uint32,uint16,uint16,uint8)"

# 1) a finished fixed-order circle, so the savings score has history
tx ${K[0]} $F "createCircle(string,$CFG_T)" "Studio rent pool" "$(cfg 50000000 50000000 3 120 2000 0 0)"
C1=$(latest); join_all $C1 3
for r in 1 2 3; do pay_all $C1 3; tx ${K[0]} $C1 "settleRound()"; done
echo "completed circle $C1"

# 2) a live auction circle in round 2 with a bid on the table
tx ${K[1]} $F "createCircle(string,$CFG_T)" "Friday lunch circle" "$(cfg 100000000 100000000 5 120 2000 1000 1)"
C2=$(latest); join_all $C2 5
pay_all $C2 5
tx ${K[3]} $C2 "bid(uint128)" 25000000
cast rpc --rpc-url $RPC evm_increaseTime 130 >/dev/null; cast rpc --rpc-url $RPC evm_mine >/dev/null
tx ${K[0]} $C2 "settleRound()"
for i in 0 1 2; do tx ${K[$i]} $C2 "contribute()"; done
tx ${K[2]} $C2 "bid(uint128)" 18000000
echo "live auction circle $C2"

# 3) a forming circle with open seats
tx ${K[2]} $F "createCircle(string,$CFG_T)" "Night-shift nurses tanda" "$(cfg 200000000 200000000 6 604800 1500 0 0)"
C3=$(latest); join_all $C3 2
echo "forming circle $C3"
