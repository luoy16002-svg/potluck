// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PotluckFactory} from "../src/PotluckFactory.sol";
import {TestUSDG} from "../src/mocks/TestUSDG.sol";

/// Deploys the factory (which deploys the circle implementation and the reputation registry).
/// On testnets without a Paxos USDG deployment it also deploys TestUSDG; set USDG=<address> to use a real one.
contract Deploy is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_KEY");
        address usdg = vm.envOr("USDG", address(0));
        vm.startBroadcast(key);
        PotluckFactory factory = new PotluckFactory();
        if (usdg == address(0)) usdg = address(new TestUSDG());
        vm.stopBroadcast();
        console2.log("factory", address(factory));
        console2.log("reputation", address(factory.reputation()));
        console2.log("usdg", usdg);
        string memory json = string.concat(
            '{"factory":"', vm.toString(address(factory)), '","reputation":"', vm.toString(address(factory.reputation())),
            '","usdg":"', vm.toString(usdg), '","block":', vm.toString(block.number), "}"
        );
        vm.writeFile(string.concat("deployments/", vm.toString(block.chainid), ".json"), json);
    }
}
