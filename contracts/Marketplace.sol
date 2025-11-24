// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Marketplace is ReentrancyGuard {
    
    enum ListingType { NFT, FRACTIONAL }
    
    struct Listing {
        address seller;
        address nftAddress;
        uint256 tokenId;
        address tokenAddress;
        uint256 price;
        uint256 amount;
        ListingType listingType;
        bool isActive;
    }

    uint256 public nextListingId;
    mapping(uint256 => Listing) public listings;

    event Listed(uint256 indexed listingId, address indexed seller, uint256 tokenId, uint256 price, ListingType listingType);
    event Sold(uint256 indexed listingId, address indexed buyer, uint256 price, uint256 amount);
    event Cancelled(uint256 indexed listingId);

    function listNFT(address nftAddress, uint256 tokenId, uint256 price) external returns (uint256) {
        require(price > 0, "Price must be greater than 0");
        require(IERC721(nftAddress).ownerOf(tokenId) == msg.sender, "Not owner");
        require(IERC721(nftAddress).isApprovedForAll(msg.sender, address(this)) || 
                IERC721(nftAddress).getApproved(tokenId) == address(this), "Not approved");

        uint256 listingId = nextListingId++;
        
        listings[listingId] = Listing({
            seller: msg.sender,
            nftAddress: nftAddress,
            tokenId: tokenId,
            tokenAddress: address(0),
            price: price,
            amount: 1,
            listingType: ListingType.NFT,
            isActive: true
        });

        emit Listed(listingId, msg.sender, tokenId, price, ListingType.NFT);
        return listingId;
    }

    function listFractionalTokens(
        address nftAddress,
        uint256 tokenId,
        address tokenAddress,
        uint256 amount,
        uint256 pricePerToken
    ) external returns (uint256) {
        require(amount > 0, "Amount must be greater than 0");
        require(pricePerToken > 0, "Price must be greater than 0");
        
        IERC20 token = IERC20(tokenAddress);
        require(token.balanceOf(msg.sender) >= amount, "Insufficient balance");
        require(token.allowance(msg.sender, address(this)) >= amount, "Not approved");

        uint256 listingId = nextListingId++;
        
        listings[listingId] = Listing({
            seller: msg.sender,
            nftAddress: nftAddress,
            tokenId: tokenId,
            tokenAddress: tokenAddress,
            price: pricePerToken,
            amount: amount,
            listingType: ListingType.FRACTIONAL,
            isActive: true
        });

        emit Listed(listingId, msg.sender, tokenId, pricePerToken, ListingType.FRACTIONAL);
        return listingId;
    }

    function buyNFT(uint256 listingId) external payable nonReentrant {
        Listing storage listing = listings[listingId];
        
        require(listing.isActive, "Not active");
        require(listing.listingType == ListingType.NFT, "Not NFT listing");
        require(msg.value == listing.price, "Wrong price");
        require(msg.sender != listing.seller, "Cannot buy own NFT");

        listing.isActive = false;

        IERC721(listing.nftAddress).transferFrom(listing.seller, msg.sender, listing.tokenId);

        (bool success, ) = listing.seller.call{value: msg.value}("");
        require(success, "Payment failed");

        emit Sold(listingId, msg.sender, listing.price, 1);
    }

    function buyFractionalTokens(uint256 listingId, uint256 amount) external payable nonReentrant {
        Listing storage listing = listings[listingId];
        
        require(listing.isActive, "Not active");
        require(listing.listingType == ListingType.FRACTIONAL, "Not fractional listing");
        require(amount > 0 && amount <= listing.amount, "Invalid amount");
        require(msg.sender != listing.seller, "Cannot buy own tokens");

        uint256 totalPrice = listing.price * amount;
        require(msg.value == totalPrice, "Wrong price");

        IERC20(listing.tokenAddress).transferFrom(listing.seller, msg.sender, amount);

        listing.amount -= amount;
        if (listing.amount == 0) {
            listing.isActive = false;
        }

        (bool success, ) = listing.seller.call{value: totalPrice}("");
        require(success, "Payment failed");

        emit Sold(listingId, msg.sender, totalPrice, amount);
    }

    function cancelListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        
        require(msg.sender == listing.seller, "Not seller");
        require(listing.isActive, "Not active");

        listing.isActive = false;
        emit Cancelled(listingId);
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }
}