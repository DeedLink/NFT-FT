// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract PropertyNFT is ERC721, Ownable, AccessControl {
    uint256 public nextTokenId;

    bytes32 public constant SURVEYOR_ROLE = keccak256("SURVEYOR_ROLE");
    bytes32 public constant NOTARY_ROLE = keccak256("NOTARY_ROLE");
    bytes32 public constant IVSL_ROLE = keccak256("IVSL_ROLE");

    struct Metadata {
        string ipfsHash;
        string dbHash;
    }

    struct Signatures {
        address surveyor;
        address notary;
        address ivsl;
    }

    struct RentInfo {
        uint256 amount;
        uint256 period;
        uint256 lastPaid;
        address receiver;
    }

    enum PoARights { SIGN, TRANSFER, FRACTIONALIZE, PAY_RENT }

    struct PoAInfo {
        bool allowed;
        uint256 start;
        uint256 end;
    }

    mapping(uint256 => Metadata) private _tokenMetadata;
    mapping(uint256 => Signatures) private _signatures;
    mapping(uint256 => RentInfo) public rentInfo;
    mapping(uint256 => mapping(address => mapping(PoARights => PoAInfo))) public poa;

    event PropertySigned(uint256 indexed tokenId, address indexed signer, string role);
    event PoASet(uint256 indexed tokenId, address indexed agent, PoARights right, bool allowed, uint256 start, uint256 end);
    event RentPaid(uint256 indexed tokenId, address indexed payer, uint256 amount, uint256 timestamp);

    constructor(address initialOwner) ERC721("RealEstateNFT", "RE-NFT") Ownable(initialOwner) {
        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner);
    }

    modifier onlyOwnerOrActiveAgent(uint256 tokenId, PoARights right) {
        PoAInfo memory agent = poa[tokenId][msg.sender][right];
        require(
            _isAuthorized(tokenId, agent),
            "Not authorized"
        );
        _;
    }

    function _isAuthorized(uint256 tokenId, PoAInfo memory agent) internal view returns (bool) {
        return (msg.sender == ownerOf(tokenId) ||
            (agent.allowed && block.timestamp >= agent.start && block.timestamp <= agent.end));
    }

    function mintProperty(address to, string memory ipfsHash, string memory dbHash) external {
        uint256 tokenId = nextTokenId++;
        _safeMint(to, tokenId);
        _tokenMetadata[tokenId] = Metadata(ipfsHash, dbHash);
    }

    function signProperty(uint256 tokenId) external {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");

        if (hasRole(SURVEYOR_ROLE, msg.sender)) {
            require(_signatures[tokenId].surveyor == address(0), "Already signed");
            _signatures[tokenId].surveyor = msg.sender;
            emit PropertySigned(tokenId, msg.sender, "SURVEYOR");
        } else if (hasRole(NOTARY_ROLE, msg.sender)) {
            require(_signatures[tokenId].notary == address(0), "Already signed");
            _signatures[tokenId].notary = msg.sender;
            emit PropertySigned(tokenId, msg.sender, "NOTARY");
        } else if (hasRole(IVSL_ROLE, msg.sender)) {
            require(_signatures[tokenId].ivsl == address(0), "Already signed");
            _signatures[tokenId].ivsl = msg.sender;
            emit PropertySigned(tokenId, msg.sender, "IVSL");
        } else {
            revert("Not authorized to sign");
        }
    }

    function getRolesOf(address account) external view returns (bool, bool, bool) {
        return (
            hasRole(SURVEYOR_ROLE, account),
            hasRole(NOTARY_ROLE, account),
            hasRole(IVSL_ROLE, account)
        );
    }

    function getSignatures(uint256 tokenId) external view returns (address, address, address) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        Signatures memory s = _signatures[tokenId];
        return (s.surveyor, s.notary, s.ivsl);
    }

    function isSignedBySurveyor(uint256 tokenId) public view returns (bool) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        return _signatures[tokenId].surveyor != address(0);
    }

    function isSignedByNotary(uint256 tokenId) public view returns (bool) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        return _signatures[tokenId].notary != address(0);
    }

    function isSignedByIVSL(uint256 tokenId) public view returns (bool) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        return _signatures[tokenId].ivsl != address(0);
    }

    function isFullySigned(uint256 tokenId) public view returns (bool) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        return _signatures[tokenId].surveyor != address(0) &&
               _signatures[tokenId].notary != address(0) &&
               _signatures[tokenId].ivsl != address(0);
    }

    function getMetadata(uint256 tokenId) external view returns (string memory, string memory) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        Metadata memory metadata = _tokenMetadata[tokenId];
        return (metadata.ipfsHash, metadata.dbHash);
    }

    function setPoA(
        uint256 tokenId,
        address agent,
        PoARights right,
        bool allowed,
        uint256 start,
        uint256 end
    ) external {
        require(ownerOf(tokenId) == msg.sender, "Only owner can assign PoA");
        require(end > start, "Invalid period");
        poa[tokenId][agent][right] = PoAInfo(allowed, start, end);
        emit PoASet(tokenId, agent, right, allowed, start, end);
    }

    function setRent(uint256 tokenId, uint256 amount, uint256 period, address receiver) external {
        require(ownerOf(tokenId) == msg.sender, "Only owner can set rent");
        require(receiver != address(0), "Invalid receiver address");
        require(amount > 0, "Rent amount must be greater than 0");
        require(period > 0, "Rent period must be greater than 0");
        rentInfo[tokenId] = RentInfo(amount, period, block.timestamp, receiver);
    }

    function payRent(uint256 tokenId) external payable {
        RentInfo storage rent = rentInfo[tokenId];
        require(rent.amount > 0, "Rent not set");
        require(msg.value == rent.amount, "Incorrect amount");
        require(block.timestamp >= rent.lastPaid + rent.period, "Payment not due yet");
        
        bool isReceiver = msg.sender == rent.receiver;
        bool isOwner = ownerOf(tokenId) == msg.sender;
        bool hasPoA = _isAuthorized(tokenId, poa[tokenId][msg.sender][PoARights.PAY_RENT]);
        require(isReceiver || isOwner || hasPoA, "Not authorized to pay rent");

        rent.lastPaid = block.timestamp;
        payable(rent.receiver).transfer(msg.value);
        emit RentPaid(tokenId, msg.sender, msg.value, block.timestamp);
    }

    function endRent(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Only owner can end rent");
        RentInfo storage rent = rentInfo[tokenId];
        require(rent.amount > 0, "Rent not set");
        rent.amount = 0;
        rent.period = 0;
        rent.receiver = address(0);
    }

    function isRentActive(uint256 tokenId) public view returns (bool) {
        RentInfo memory rent = rentInfo[tokenId];
        if (rent.amount == 0) return false;
        return block.timestamp < rent.lastPaid + rent.period;
    }

    event RentReceiverUpdated(uint256 indexed tokenId, address indexed oldReceiver, address indexed newReceiver);
    event RentEndedOnTransfer(uint256 indexed tokenId, address indexed previousOwner, address indexed newOwner);

    function _update(address to, uint256 tokenId, address auth) internal virtual override returns (address) {
        address from = _ownerOf(tokenId);
        
        if (from != address(0)) {
            require(isFullySigned(tokenId), "Property must be fully signed before transfer");
            
            RentInfo storage rent = rentInfo[tokenId];
            if (rent.amount > 0 && rent.receiver != address(0)) {
                address oldReceiver = rent.receiver;
                
                if (to == oldReceiver) {
                    rent.receiver = address(0);
                    rent.amount = 0;
                    rent.period = 0;
                    emit RentEndedOnTransfer(tokenId, from, to);
                } else {
                    rent.receiver = to;
                    emit RentReceiverUpdated(tokenId, oldReceiver, to);
                }
            }
        }
        
        return super._update(to, tokenId, auth);
    }
    
    function updateRentReceiver(uint256 tokenId, address newReceiver) external {
        require(ownerOf(tokenId) == msg.sender, "Only owner can update rent receiver");
        RentInfo storage rent = rentInfo[tokenId];
        require(rent.amount > 0, "Rent not set");
        require(newReceiver != address(0), "Invalid receiver address");
        address oldReceiver = rent.receiver;
        rent.receiver = newReceiver;
        emit RentReceiverUpdated(tokenId, oldReceiver, newReceiver);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}