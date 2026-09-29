"""Drive a testnet circle to completion with the demo wallets in .env (keys never printed).

Every round: each member in good standing pays, one random member who has not won yet bids
(auction mode), and the round is settled as soon as the rules allow.

Usage: python script/run_circle.py <circle> [--rpc URL]
"""
import os
import random
import subprocess
import sys
import time

RPC = 'https://rpc.testnet.chain.robinhood.com/rpc'
if '--rpc' in sys.argv:
    RPC = sys.argv[sys.argv.index('--rpc') + 1]
C = sys.argv[1]
env = dict(l.strip().split('=', 1) for l in open(os.path.join(os.path.dirname(__file__), '..', '.env')) if '=' in l)
KEYS = [env['DEPLOYER_KEY']] + env['DEMO_KEYS'].split(',')


def cast(*a):
    """cast with retries: the public testnet RPC sometimes returns empty or errors for a minute."""
    for _ in range(20):
        r = subprocess.run(['cast', *a], capture_output=True, text=True, encoding='utf-8', errors='replace')
        if a[0] == 'send' or (r.returncode == 0 and r.stdout.strip()):
            return r
        time.sleep(3)
    return r


def call(sig, *args):
    r = cast('call', '--rpc-url', RPC, C, sig, *map(str, args))
    return r.stdout.strip().split(' ')[0]


def send(key, sig, *args):
    for _ in range(4):
        r = cast('send', '--rpc-url', RPC, '--private-key', key, C, sig, *map(str, args))
        if r.returncode == 0:
            return True
        err = (r.stderr or '')[-160:]
        if 'revert' in err.lower():
            print('  revert:', sig, err.strip().splitlines()[-1] if err.strip() else '')
            return False
        time.sleep(3)
    return False


addr = {subprocess.run(['cast', 'wallet', 'address', k], capture_output=True, text=True, encoding='utf-8', errors='replace').stdout.strip().lower(): k for k in KEYS}
members = [m.strip().lower() for m in call('members()(address[])').strip('[]').split(',')] if False else None
out = cast('call', '--rpc-url', RPC, C, 'members()(address[])').stdout.strip().strip('[]')
members = [m.strip().lower() for m in out.split(',') if m.strip()]
cfg = cast('call', '--rpc-url', RPC, C, 'config()((address,uint128,uint128,uint8,uint32,uint32,uint16,uint16,uint8))').stdout
auction = cfg.strip().rstrip(')').split(',')[-1].strip() == '1'
max_disc = int(call('maxDiscount()(uint128)'))
print('members', len(members), 'auction', auction)

while call('phase()(uint8)') == '1':
    r = int(call('currentRound()(uint8)'))
    for m in members:
        info = cast('call', '--rpc-url', RPC, C, 'memberInfo(address)((bool,bool,bool,bool,uint8,uint8,uint8,uint128,uint128,uint128,uint128,uint128))', m).stdout
        defaulted = info.split(',')[2].strip() == 'true'
        if defaulted or call('paid(uint256,address)(bool)', r, m) == 'true':
            continue
        send(addr[m], 'contribute()')
    if auction:
        open_ = [m for m in members if cast('call', '--rpc-url', RPC, C, 'memberInfo(address)((bool,bool,bool,bool,uint8,uint8,uint8,uint128,uint128,uint128,uint128,uint128))', m).stdout.split(',')[1].strip() == 'false']
        now = int(cast('block', 'latest', '--rpc-url', RPC, '-f', 'timestamp').stdout.strip())
        deadline = int(call('roundDeadline(uint256)(uint256)', r))
        if len(open_) > 1 and now < deadline - 20:
            who = random.choice(open_)
            d = random.randrange(max_disc // 4, max_disc + 1, 1_000_000) if max_disc >= 4_000_000 else 0
            send(addr[who], 'bid(uint128)', d)
            print(f'round {r}: bid {d / 1e6:.0f} by {who[:8]}')
        now = int(cast('block', 'latest', '--rpc-url', RPC, '-f', 'timestamp').stdout.strip())
        if now <= deadline:
            time.sleep(deadline - now + 4)
    ok = send(KEYS[0], 'settleRound()')
    print(f'round {r} settled: {ok}', flush=True)
print('phase', call('phase()(uint8)'))
for m in members:
    send(addr[m], 'withdraw()')
print('done')
