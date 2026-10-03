"""Complete an existing testnet circle. Build ABIs first with `forge build`.

Arc: python script/run_circle.py <circle> --network arc-testnet
Local Arc fork: add --rpc http://127.0.0.1:8545 --anvil

Arc wallets are loaded from .env.arc only inside main(), after checking the RPC.
--anvil derives public development wallets in memory and never reads a key file.
No wallet material is passed to a subprocess, logged, or written to disk.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from eth_account import Account
from web3 import Web3

ROOT = Path(__file__).resolve().parent.parent
USDC = "0x3600000000000000000000000000000000000000"
ARC_IDS = {5042, 5042002}
RPCS = {
    "arc-testnet": (5042002, "https://rpc.testnet.arc.io"),
    "arc-mainnet": (5042, "https://rpc.mainnet.arc.io"),
    "robinhood-testnet": (46630, "https://rpc.testnet.chain.robinhood.com/rpc"),
    "monad-testnet": (10143, "https://testnet-rpc.monad.xyz"),
    "arbitrum-sepolia": (421614, "https://sepolia-rollup.arbitrum.io/rpc"),
}
TESTNET_IDS = {5042002, 46630, 10143, 421614, 31337}
ARC_FEE_FLOOR = 20_000_000_000  # Native USDC units/gas; native precision is 18.


class RunnerError(Exception):
    pass


def artifact(name):
    path = ROOT / "out" / f"{name}.sol" / f"{name}.json"
    if not path.is_file():
        raise RunnerError("Missing contract artifacts; run forge build first")
    return json.loads(path.read_text(encoding="utf-8"))


def local_anvil(w3):
    """Require a literal loopback endpoint and an actual Anvil RPC response."""
    url = urlparse(w3.provider.endpoint_uri)
    if url.scheme != "http" or url.hostname not in {"127.0.0.1", "::1"}:
        raise RunnerError("--anvil requires an HTTP loopback RPC")
    result = w3.provider.make_request("anvil_nodeInfo", [])
    if "error" in result or not isinstance(result.get("result"), dict):
        raise RunnerError("--anvil requires an Anvil node")
    if w3.eth.chain_id in ARC_IDS and result["result"].get("network") != "arc":
        raise RunnerError("Arc forks require Arc Foundry's arc-anvil runtime")


def validate_network(w3, anvil=False, expected_chain=None):
    chain_id = w3.eth.chain_id
    if expected_chain is not None and chain_id != expected_chain:
        raise RunnerError("RPC chain ID does not match the selected network")
    if anvil:
        local_anvil(w3)
    elif chain_id not in TESTNET_IDS:
        # This happens before loading any wallet file, including .env.arc.
        raise RunnerError("The live-circle runner only submits to testnets; mainnet is disabled")
    return chain_id


def anvil_wallets():
    Account.enable_unaudited_hdwallet_features()
    mnemonic = "test test test test test test test test test test test junk"
    # Arc testnet deliberately blocklists the usual Anvil account at index 1.
    return [Account.from_mnemonic(mnemonic, account_path=f"m/44'/60'/0'/0/{i}") for i in (0, 2, 3)]


def load_wallets(chain_id, anvil=False):
    if anvil:
        return anvil_wallets()
    # Runtime-only secret loading. Importing this module does not read a key file.
    from dotenv import dotenv_values

    arc = chain_id in ARC_IDS
    values = dotenv_values(ROOT / (".env.arc" if arc else ".env"), interpolate=False)

    def value(name):
        return os.environ.get(name) or values.get(name)

    try:
        if arc:
            accounts = []
            for prefix in ("ARC_DEPLOYER", "ARC_MEMBER1", "ARC_MEMBER2"):
                account = Account.from_key(value(prefix + "_KEY"))
                address = value(prefix + "_ADDRESS")
                if not address or account.address.lower() != address.lower():
                    raise RunnerError(f"{prefix}_ADDRESS does not match its configured wallet")
                accounts.append(account)
            return accounts
        return [Account.from_key(k) for k in [value("DEPLOYER_KEY"), *value("DEMO_KEYS").split(",")]]
    except RunnerError:
        raise
    except Exception:
        raise RunnerError("Missing or invalid wallet configuration (values suppressed)") from None


def fee_fields(w3):
    block = w3.eth.get_block("latest")
    price = w3.eth.gas_price
    if w3.eth.chain_id in ARC_IDS:
        base = block.get("baseFeePerGas", ARC_FEE_FLOOR)
        tip = min(max(price - base, 0), 1_000_000_000)
        return {"type": 2, "maxFeePerGas": max(ARC_FEE_FLOOR, price, 2 * base + tip),
                "maxPriorityFeePerGas": tip}
    return {"gasPrice": price}


def submit(w3, account, fn, label, records, token=None, token_spend=0):
    """Estimate each action; sign in memory; submit once; require a successful receipt."""
    try:
        fees = fee_fields(w3)
        tx = {"from": account.address, "chainId": w3.eth.chain_id,
              "nonce": w3.eth.get_transaction_count(account.address, "pending"), **fees}
        # Monad charges the limit; Arc charges actual gas used. Final settlement's
        # reputation gas guard makes a fresh estimate necessary on every round.
        percent = 110 if w3.eth.chain_id == 10143 else 130
        tx["gas"] = (fn.estimate_gas(tx) * percent + 99) // 100
        native_required = tx["gas"] * fees.get("maxFeePerGas", fees.get("gasPrice", 0))
        if token_spend:
            if token.functions.balanceOf(account.address).call() < token_spend:
                raise RunnerError(f"{label}: insufficient token balance")
            if w3.eth.chain_id in ARC_IDS and token.address.lower() == USDC.lower():
                native_required += token_spend * 10**12
        if w3.eth.get_balance(account.address) < native_required:
            raise RunnerError(f"{label}: insufficient native balance for payment plus gas reserve")
        signed = account.sign_transaction(fn.build_transaction(tx))
    except RunnerError:
        raise
    except Exception as exc:
        raise RunnerError(f"{label}: preparation failed ({type(exc).__name__}; details suppressed)") from None

    tx_hash = signed.hash
    try:
        w3.eth.send_raw_transaction(signed.raw_transaction)
    except Exception:
        # An RPC may accept the submission before the connection fails. Poll the
        # known hash; never sign/send the action again automatically.
        pass
    try:
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120, poll_latency=1)
    except Exception:
        raise RunnerError(f"{label}: no receipt for {tx_hash.hex()}; stopped without resubmitting") from None
    if receipt.status != 1:
        raise RunnerError(f"{label}: transaction reverted ({tx_hash.hex()})")
    records.append({"action": label, "sender": account.address, "gasUsed": receipt.gasUsed,
                    "gasLimit": tx["gas"], "effectiveGasPrice": receipt.effectiveGasPrice,
                    "transactionHash": tx_hash.hex()})
    print(f"{label}: gas {receipt.gasUsed}", flush=True)
    return receipt


def wait_past_deadline(w3, deadline, anvil):
    if w3.eth.get_block("latest").timestamp > deadline:
        return
    if anvil:
        local_anvil(w3)
        for method, params in (("evm_setNextBlockTimestamp", [deadline + 1]), ("evm_mine", [])):
            if "error" in w3.provider.make_request(method, params):
                raise RunnerError("Local Anvil time advance failed")
        return
    # Read chain time: Arc can have several blocks with the same timestamp.
    while w3.eth.get_block("latest").timestamp <= deadline:
        time.sleep(min(10, max(1, deadline - w3.eth.get_block("latest").timestamp + 1)))


def run_circle(w3, address, accounts, anvil=False, records=None):
    validate_network(w3, anvil)
    records = records if records is not None else []
    circle = w3.eth.contract(address=Web3.to_checksum_address(address), abi=artifact("PotluckCircle")["abi"])
    members = circle.functions.members().call()
    wallets = {a.address.lower(): a for a in accounts}
    if not members or any(m.lower() not in wallets for m in members):
        raise RunnerError("A configured wallet is required for every circle member")
    cfg = circle.functions.config().call()
    token = w3.eth.contract(address=cfg[0], abi=artifact("TestUSDG")["abi"])
    if circle.functions.phase().call() == 0:
        raise RunnerError("Fill the circle before starting the runner")

    def send(member, fn, label, spend=0):
        return submit(w3, wallets[member.lower()], fn, label, records, token, spend)

    while circle.functions.phase().call() == 1:
        r = circle.functions.currentRound().call()
        for i, member in enumerate(members):
            info = circle.functions.memberInfo(member).call()
            if info[11]:
                send(member, circle.functions.claim(), f"r{r}.claim.{i}")
            if info[2] or circle.functions.paid(r, member).call():
                continue
            if token.functions.allowance(member, circle.address).call() < cfg[1]:
                remaining = (cfg[3] - r + 1) * cfg[1]
                send(member, token.functions.approve(circle.address, remaining), f"r{r}.approve.{i}")
            send(member, circle.functions.contribute(), f"r{r}.contribute.{i}", cfg[1])
        deadline = circle.functions.roundDeadline(r).call()
        if cfg[8] == 1:
            eligible = [m for m in members if not any(circle.functions.memberInfo(m).call()[1:3])]
            top = circle.functions.topDiscount(r).call()
            cap = min(circle.functions.maxDiscount().call(), circle.functions.collected(r).call())
            if eligible and top < cap and w3.eth.get_block("latest").timestamp < deadline:
                discount = min(cap, max(cap // 4, top + 1))
                send(eligible[0], circle.functions.bid(discount), f"r{r}.bid")
            wait_past_deadline(w3, deadline, anvil)
        send(members[0], circle.functions.settleRound(), f"r{r}.settle")
        if circle.functions.phase().call() == 1 and circle.functions.currentRound().call() == r:
            raise RunnerError("Settlement did not advance the round")
        for i, member in enumerate(members):
            if circle.functions.memberInfo(member).call()[11]:
                send(member, circle.functions.claim(), f"r{r}.claim.{i}")

    phase = circle.functions.phase().call()
    if phase not in (2, 3):
        raise RunnerError("Circle did not complete or cancel")
    for i, member in enumerate(members):
        info = circle.functions.memberInfo(member).call()
        if info[7] + info[8] + info[11]:
            send(member, circle.functions.withdraw(), f"withdraw.{i}")
    print(f"done: phase {phase}, circle token balance {token.functions.balanceOf(circle.address).call()}", flush=True)
    return records


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("circle")
    parser.add_argument("--network", choices=RPCS)
    parser.add_argument("--rpc")
    parser.add_argument("--anvil", action="store_true", help="Loopback simulation, public Anvil wallets, no key file")
    args = parser.parse_args(argv)
    network = RPCS[args.network or "robinhood-testnet"]
    w3 = Web3(Web3.HTTPProvider(args.rpc or network[1], request_kwargs={"timeout": 30}))
    chain_id = validate_network(w3, args.anvil, network[0] if args.network else None)
    accounts = load_wallets(chain_id, args.anvil)
    run_circle(w3, args.circle, accounts, args.anvil)


if __name__ == "__main__":
    try:
        main()
    except RunnerError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        # Provider errors may echo request data. Never dump them or a traceback.
        print(f"Runner stopped ({type(exc).__name__}; details suppressed)", file=sys.stderr)
        sys.exit(1)
