// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IPropertyNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function isFullySigned(uint256 tokenId) external view returns (bool);
    function hasRole(bytes32 role, address account) external view returns (bool);
}