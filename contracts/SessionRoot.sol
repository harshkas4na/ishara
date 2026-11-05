// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// One write per session id: the 0G Storage Merkle root of that session's encrypted log.
/// Write-once on purpose, so a recorded root can never be swapped for a different log later.
contract SessionRoot {
    event SessionRecorded(bytes32 indexed sessionId, bytes32 root, address indexed recorder);

    mapping(bytes32 => bytes32) private roots;

    function record(bytes32 sessionId, bytes32 root) external {
        require(root != bytes32(0), "empty root");
        require(roots[sessionId] == bytes32(0), "already recorded");
        roots[sessionId] = root;
        emit SessionRecorded(sessionId, root, msg.sender);
    }

    function rootOf(bytes32 sessionId) external view returns (bytes32) {
        return roots[sessionId];
    }
}
