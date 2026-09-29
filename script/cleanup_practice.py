"""Finish or cancel practice circles the deployer created and abandoned (test runs whose bot keys are gone).

Forming circles are cancelled. Active circles are played to the end: the deployer pays every round on time and
settles after each deadline; members that no longer exist are covered by their collateral, as the rules say.
Then the deployer withdraws. Usage: python script/cleanup_practice.py [circle ...]  (default: all of the deployer's)
"""
import os, subprocess, sys, time

RPC = 'https://rpc.testnet.chain.robinhood.com/rpc'
FACTORY = '0x1A88423eaE02fE8DF120019D99c859679F20bA0C'
env = dict(l.strip().split('=', 1) for l in open(os.path.join(os.path.dirname(__file__), '..', '.env')) if '=' in l and not l.startswith('#'))
KEY, ME = env['DEPLOYER_KEY'], env['DEPLOYER_ADDRESS'].lower()


def cast(*a):
    for _ in range(20):
        r = subprocess.run(['cast', *a, '--rpc-url', RPC], capture_output=True, text=True, encoding='utf-8', errors='replace')
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
        time.sleep(2)
    raise RuntimeError(r.stderr)


def send(to, sig, *args):
    r = subprocess.run(['cast', 'send', '--rpc-url', RPC, '--private-key', KEY, to, sig, *args], capture_output=True, text=True, encoding='utf-8', errors='replace')
    ok = r.returncode == 0 or 'null response' in r.stderr
    print(f'    {sig}: {"ok" if ok else r.stderr.strip().splitlines()[-1][:120]}', flush=True)
    return ok


def num(s):
    return int(s.split()[0])


def member(c):
    # (joined, won, defaulted, withdrawn, wonRound, onTime, missed, collateralLeft, bond, contributed, received, claimable)
    t = cast('call', c, 'memberInfo(address)((bool,bool,bool,bool,uint8,uint8,uint8,uint128,uint128,uint128,uint128,uint128))', ME)
    f = [x.strip().split(' ')[0] for x in t.strip('()').split(',')]
    return {'joined': f[0] == 'true', 'defaulted': f[2] == 'true', 'owed': num(f[7]) + num(f[8]) + num(f[11])}


circles = sys.argv[1:] or [a.strip() for a in cast('call', FACTORY, 'circlesCreatedBy(address)(address[])', ME).strip('[]').split(',') if a.strip()]
token = None
for c in circles:
    phase = num(cast('call', c, 'phase()(uint8)'))
    print(f'{c} phase {phase}', flush=True)
    if phase == 0:
        send(c, 'cancel()')
        phase = 3
    while phase == 1:
        r = num(cast('call', c, 'currentRound()(uint8)'))
        paid = cast('call', c, 'paid(uint256,address)(bool)', str(r), ME) == 'true'
        m = member(c)
        if m['joined'] and not m['defaulted'] and not paid:
            token = token or cast('call', c, 'config()((address,uint128,uint128,uint8,uint32,uint32,uint16,uint16,uint8))').strip('(').split(',')[0]
            send(token, 'approve(address,uint256)', c, str(10**30))
            send(c, 'contribute()')
        deadline = num(cast('call', c, 'roundDeadline(uint256)(uint256)', str(r)))
        wait = deadline - int(time.time()) + 3
        if wait > 0:
            print(f'    round {r}: waiting {wait}s for the deadline', flush=True)
            time.sleep(wait)
        send(c, 'settleRound()')
        phase = num(cast('call', c, 'phase()(uint8)'))
    if phase in (2, 3) and member(c)['owed'] > 0:
        send(c, 'withdraw()')
    print(f'  -> phase {num(cast("call", c, "phase()(uint8)"))}', flush=True)
