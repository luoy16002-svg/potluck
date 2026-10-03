// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PotluckFactory} from "../src/PotluckFactory.sol";
import {TestUSDG} from "../src/mocks/TestUSDG.sol";

/// Deploys the factory (which deploys the circle implementation and the reputation registry).
/// Arc defaults to system USDC. Other networks may deploy TestUSDG when USDG is unset.
contract Deploy is Script {
    function run() external {
        address usdg = vm.envOr("USDG", address(0));
        bool arc = block.chainid == 5042 || block.chainid == 5042002;
        if (arc && usdg == address(0)) usdg = 0x3600000000000000000000000000000000000000;
        // A key is optional for a read-only forge script simulation. No key file is loaded here.
        uint256 key = vm.envOr("DEPLOYER_KEY", uint256(0));
        if (key == 0) vm.startBroadcast();
        else vm.startBroadcast(key);
        PotluckFactory factory = new PotluckFactory();
        if (usdg == address(0)) usdg = address(new TestUSDG());
        vm.stopBroadcast();
        console2.log("factory", address(factory));
        console2.log("reputation", address(factory.reputation()));
        console2.log("usdg", usdg);
        string memory json = string.concat(
            '{"factory":"',
            vm.toString(address(factory)),
            '","reputation":"',
            vm.toString(address(factory.reputation())),
            '","usdg":"',
            vm.toString(usdg),
            '","block":',
            vm.toString(block.number),
            "}"
        );
        vm.writeFile(string.concat("deployments/", vm.toString(block.chainid), ".json"), json);
    }
}
