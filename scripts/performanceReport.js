const { ethers } = require("hardhat");
const { performance } = require("perf_hooks");
const fs = require("fs/promises");
const path = require("path");
const http = require("http");

function avg(arr, decimals = 2) {
  if (!arr.length) return 0;
  return Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(decimals));
}

async function captureTx(label, txPromise) {
  const start = performance.now();
  const tx = await txPromise;
  const receipt = await tx.wait();
  const durationMs = Number((performance.now() - start).toFixed(2));
  const gasUsed = receipt.gasUsed;
  const gasPrice = receipt.effectiveGasPrice ?? receipt.gasPrice;
  const gasSpent = gasUsed * gasPrice;
  return {
    label,
    gasUsed: gasUsed.toString(),
    gasCostEth: Number(ethers.formatEther(gasSpent)),
    durationMs,
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function measureIpfsLikeOps(iterations = 5) {
  const tempDir = path.join(__dirname, "..", "tmp-ipfs");
  await ensureDir(tempDir);

  const uploadDurations = [];
  const pinDurations = [];
  const fetchDurations = [];

  for (let i = 0; i < iterations; i++) {
    const payload = `document-${i}-${Date.now()}`.repeat(500);
    const filePath = path.join(tempDir, `doc-${i}.txt`);

    let start = performance.now();
    await fs.writeFile(filePath, payload);
    uploadDurations.push(performance.now() - start);

    start = performance.now();
    const pinnedPath = path.join(tempDir, `pinned-${i}.txt`);
    await fs.copyFile(filePath, pinnedPath);
    pinDurations.push(performance.now() - start);

    start = performance.now();
    await fs.readFile(filePath, "utf8");
    fetchDurations.push(performance.now() - start);
  }

  return {
    uploadMsAvg: avg(uploadDurations),
    pinMsAvg: avg(pinDurations),
    metadataFetchMsAvg: avg(fetchDurations),
    iterations,
  };
}

function startMockBackend(port = 5055) {
  const server = http.createServer((req, res) => {
    const start = performance.now();
    let body = [];
    req.on("data", (chunk) => body.push(chunk));
    req.on("end", () => {
      const payload = body.length ? Buffer.concat(body).toString() : "{}";
      const wait = 25 + Math.floor(Math.random() * 50); // 25-75ms artificial latency
      setTimeout(() => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            path: req.url,
            method: req.method,
            received: payload ? JSON.parse(payload) : null,
            handledInMs: Number((performance.now() - start).toFixed(2)),
          })
        );
      }, wait);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

async function measureApiLatency(port = 5055, iterations = 5) {
  const server = await startMockBackend(port);
  const endpoints = [
    {
      label: "Auth Login",
      path: "/auth/login",
      init: {
        method: "POST",
        body: JSON.stringify({ email: "buyer@example.com", password: "secret" }),
        headers: { "Content-Type": "application/json" },
      },
    },
    {
      label: "Escrow Create",
      path: "/transactions",
      init: {
        method: "POST",
        body: JSON.stringify({ buyerId: 1, sellerId: 2, amount: 1 }),
        headers: { "Content-Type": "application/json" },
      },
    },
    {
      label: "Document Pin",
      path: "/documents/123/pin",
      init: {
        method: "POST",
        body: JSON.stringify({ cid: "bafy..." }),
        headers: { "Content-Type": "application/json" },
      },
    },
  ];

  const latencies = {};
  for (const endpoint of endpoints) {
    const durations = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}${endpoint.path}`, endpoint.init);
      await response.json();
      durations.push(performance.now() - start);
    }
    latencies[endpoint.label] = avg(durations);
  }

  await new Promise((resolve) => server.close(resolve));
  return { latencies, iterations };
}

async function measureMetadataFetch(contract, tokenId, iterations = 5) {
  const durations = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await contract.getMetadata(tokenId);
    durations.push(performance.now() - start);
  }
  return avg(durations);
}

async function main() {
  console.log("=== Running property transaction performance suite ===");
  const [admin, surveyor, notary, ivsl, buyer, seller] = await ethers.getSigners();

  const loginStart = performance.now();
  const buyerAddr = await buyer.getAddress();
  const sellerAddr = await seller.getAddress();
  const loginDurationMs = Number((performance.now() - loginStart).toFixed(2));

  console.log("Auto-login complete", { buyer: buyerAddr, seller: sellerAddr, durationMs: loginDurationMs });

  const PropertyNFT = await ethers.getContractFactory("PropertyNFT");
  const HybridEscrow = await ethers.getContractFactory("HybridEscrow");
  const StampFeeCollector = await ethers.getContractFactory("StampFeeCollector");

  const propertyNFT = await PropertyNFT.deploy(admin.address);
  await propertyNFT.waitForDeployment();
  const propertyNFTAddress = await propertyNFT.getAddress();

  const stampFeeCollector = await StampFeeCollector.deploy(admin.address);
  await stampFeeCollector.waitForDeployment();

  // Role setup
  const SURVEYOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SURVEYOR_ROLE"));
  const NOTARY_ROLE = ethers.keccak256(ethers.toUtf8Bytes("NOTARY_ROLE"));
  const IVSL_ROLE = ethers.keccak256(ethers.toUtf8Bytes("IVSL_ROLE"));
  await (await propertyNFT.grantRole(SURVEYOR_ROLE, surveyor.address)).wait();
  await (await propertyNFT.grantRole(NOTARY_ROLE, notary.address)).wait();
  await (await propertyNFT.grantRole(IVSL_ROLE, ivsl.address)).wait();

  const txMetrics = [];
  txMetrics.push(
    await captureTx("Mint Property NFT", propertyNFT.mintProperty(seller.address, "ipfs://demoHash", "db://demoHash"))
  );
  console.log("Owner after mint", await propertyNFT.ownerOf(0));

  txMetrics.push(await captureTx("Surveyor Sign", propertyNFT.connect(surveyor).signProperty(0)));
  txMetrics.push(await captureTx("Notary Sign", propertyNFT.connect(notary).signProperty(0)));
  txMetrics.push(await captureTx("IVSL Sign", propertyNFT.connect(ivsl).signProperty(0)));

  const escrow = await HybridEscrow.deploy(
    buyer.address,
    seller.address,
    ethers.parseEther("1"),
    0,
    propertyNFTAddress,
    0
  );
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();

  txMetrics.push(
    await captureTx(
      "Authorize Escrow Transfer",
      propertyNFT.connect(seller).setApprovalForAll(escrowAddress, true)
    )
  );
  console.log("Escrow approval set:", await propertyNFT.isApprovedForAll(seller.address, escrowAddress));

  txMetrics.push(
    await captureTx("Deposit Buyer Payment", escrow.connect(buyer).depositPayment({ value: ethers.parseEther("1") }))
  );
  txMetrics.push(await captureTx("Deposit Seller NFT", escrow.connect(seller).depositNFTAsset()));
  txMetrics.push(await captureTx("Finalize Escrow", escrow.connect(buyer).finalize()));

  const stampTx = await captureTx(
    "Pay Stamp Fee",
    stampFeeCollector.connect(buyer).payStampFee(0, { value: ethers.parseEther("0.01") })
  );
  txMetrics.push(stampTx);

  const gasUsedTotal = txMetrics.reduce((acc, tx) => acc + BigInt(tx.gasUsed), 0n);
  const gasCostTotalEth = txMetrics.reduce((acc, tx) => acc + tx.gasCostEth, 0);

  const mintingCostEth = txMetrics.find((tx) => tx.label === "Mint Property NFT").gasCostEth;
  const signingTxs = txMetrics.filter((tx) => tx.label.includes("Sign"));
  const signingCostEthAvg = avg(signingTxs.map((tx) => tx.gasCostEth), 6);
  const escrowOps = txMetrics.filter((tx) =>
    ["Authorize Escrow Transfer", "Deposit Buyer Payment", "Deposit Seller NFT", "Finalize Escrow"].includes(tx.label)
  );
  const escrowOpsCostEth = escrowOps.reduce((acc, tx) => acc + tx.gasCostEth, 0);
  const ownershipTransferCostEth = txMetrics.find((tx) => tx.label === "Finalize Escrow").gasCostEth;

  const ipfsMetrics = await measureIpfsLikeOps(5);
  const onChainMetadataLatencyMs = await measureMetadataFetch(propertyNFT, 0, 5);
  ipfsMetrics.contractMetadataFetchMsAvg = Number(onChainMetadataLatencyMs.toFixed(2));

  const apiLatencyMetrics = await measureApiLatency(5055, 5);

  const report = {
    userSessions: {
      buyer: buyerAddr,
      seller: sellerAddr,
      autoLoginMs: loginDurationMs,
    },
    gasUsage: {
      totalGasUsed: gasUsedTotal.toString(),
      totalGasCostEth: Number(gasCostTotalEth.toFixed(6)),
      mintingCostEth,
      signingCostEthAvg,
      escrowOpsCostEth: Number(escrowOpsCostEth.toFixed(6)),
      ownershipTransferCostEth,
      stampFeeCostEth: stampTx.gasCostEth,
    },
    timings: txMetrics.reduce((acc, tx) => {
      acc[tx.label] = tx.durationMs;
      return acc;
    }, {}),
    ipfs: ipfsMetrics,
    apiLatency: apiLatencyMetrics,
    blockchainTransactions: txMetrics,
  };

  console.log("\n=== Transaction Metrics ===");
  console.table(
    txMetrics.map((tx) => ({
      Step: tx.label,
      "Gas Used": tx.gasUsed,
      "Gas Cost (ETH)": tx.gasCostEth,
      "Duration (ms)": tx.durationMs,
    }))
  );

  console.log("\n=== Summary ===");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});


