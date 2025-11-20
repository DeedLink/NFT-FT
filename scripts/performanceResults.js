const { ethers } = require("hardhat");
const { performance } = require("perf_hooks");
const fs = require("fs/promises");
const path = require("path");
const http = require("http");

function avg(values, decimals = 2) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Number(mean.toFixed(decimals));
}

async function captureTxStep(label, txPromise) {
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

async function ensureTempDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function measureIpfsSurrogates(iterations = 5) {
  const tmpRoot = path.join(__dirname, "..", "tmp-ipfs");
  await ensureTempDir(tmpRoot);

  const uploadDurations = [];
  const pinDurations = [];
  const fetchDurations = [];

  for (let i = 0; i < iterations; i++) {
    const payload = `doc-${i}-${Date.now()}`.repeat(500);
    const filePath = path.join(tmpRoot, `doc-${i}.txt`);

    let start = performance.now();
    await fs.writeFile(filePath, payload);
    uploadDurations.push(performance.now() - start);

    const pinPath = path.join(tmpRoot, `pin-${i}.txt`);
    start = performance.now();
    await fs.copyFile(filePath, pinPath);
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

function startMockServer(port = 5088) {
  const server = http.createServer((req, res) => {
    const start = performance.now();
    let body = [];
    req.on("data", (chunk) => body.push(chunk));
    req.on("end", () => {
      const payload = body.length ? Buffer.concat(body).toString() : "{}";
      const wait = 25 + Math.floor(Math.random() * 50);
      setTimeout(() => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            path: req.url,
            tookMs: Number((performance.now() - start).toFixed(2)),
            received: payload ? JSON.parse(payload) : null,
          })
        );
      }, wait);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

async function measureApiLatency(iterations = 5, port = 5088) {
  const server = await startMockServer(port);
  const endpoints = [
    {
      label: "Auth Login",
      path: "/auth/login",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "buyer@example.com", password: "secret" }),
      },
    },
    {
      label: "Escrow Create",
      path: "/escrow",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyerId: 1, sellerId: 2, amount: 1 }),
      },
    },
    {
      label: "Document Pin",
      path: "/documents/123/pin",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cid: "bafy..." }),
      },
    },
  ];

  const latencyResults = {};
  for (const endpoint of endpoints) {
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const res = await fetch(`http://127.0.0.1:${port}${endpoint.path}`, endpoint.init);
      await res.json();
      samples.push(performance.now() - start);
    }
    latencyResults[endpoint.label] = avg(samples);
  }

  await new Promise((resolve) => server.close(resolve));
  return { latencies: latencyResults, iterations };
}

async function measureOnChainMetadata(contract, tokenId, iterations = 5) {
  const durations = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await contract.getMetadata(tokenId);
    durations.push(performance.now() - start);
  }
  return avg(durations);
}

async function main() {
  console.log("=== Property performance run ===");
  const [admin, surveyor, notary, ivsl, buyer, seller] = await ethers.getSigners();

  const loginStart = performance.now();
  const buyerAddr = await buyer.getAddress();
  const sellerAddr = await seller.getAddress();
  const autoLoginMs = Number((performance.now() - loginStart).toFixed(2));

  const PropertyNFT = await ethers.getContractFactory("PropertyNFT");
  const HybridEscrow = await ethers.getContractFactory("HybridEscrow");
  const StampFeeCollector = await ethers.getContractFactory("StampFeeCollector");

  const propertyNFT = await PropertyNFT.deploy(admin.address);
  await propertyNFT.waitForDeployment();

  const stampCollector = await StampFeeCollector.deploy(admin.address);
  await stampCollector.waitForDeployment();

  const SURVEYOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SURVEYOR_ROLE"));
  const NOTARY_ROLE = ethers.keccak256(ethers.toUtf8Bytes("NOTARY_ROLE"));
  const IVSL_ROLE = ethers.keccak256(ethers.toUtf8Bytes("IVSL_ROLE"));

  await (await propertyNFT.grantRole(SURVEYOR_ROLE, surveyor.address)).wait();
  await (await propertyNFT.grantRole(NOTARY_ROLE, notary.address)).wait();
  await (await propertyNFT.grantRole(IVSL_ROLE, ivsl.address)).wait();

  const txSteps = [];
  txSteps.push(
    await captureTxStep("Mint Property NFT", propertyNFT.mintProperty(seller.address, "ipfs://demo", "db://demo"))
  );

  txSteps.push(await captureTxStep("Surveyor Sign", propertyNFT.connect(surveyor).signProperty(0)));
  txSteps.push(await captureTxStep("Notary Sign", propertyNFT.connect(notary).signProperty(0)));
  txSteps.push(await captureTxStep("IVSL Sign", propertyNFT.connect(ivsl).signProperty(0)));

  const escrow = await HybridEscrow.deploy(
    buyer.address,
    seller.address,
    ethers.parseEther("1"),
    0,
    await propertyNFT.getAddress(),
    0
  );
  await escrow.waitForDeployment();

  txSteps.push(
    await captureTxStep(
      "Authorize Escrow Transfer",
      propertyNFT.connect(seller).setApprovalForAll(await escrow.getAddress(), true)
    )
  );
  txSteps.push(
    await captureTxStep("Deposit Buyer Payment", escrow.connect(buyer).depositPayment({ value: ethers.parseEther("1") }))
  );
  txSteps.push(await captureTxStep("Deposit Seller NFT", escrow.connect(seller).depositNFTAsset()));
  txSteps.push(await captureTxStep("Finalize Escrow", escrow.connect(buyer).finalize()));

  const stampTx = await captureTxStep(
    "Pay Stamp Fee",
    stampCollector.connect(buyer).payStampFee(0, { value: ethers.parseEther("0.01") })
  );
  txSteps.push(stampTx);

  const totalGasUsed = txSteps.reduce((acc, step) => acc + BigInt(step.gasUsed), 0n);
  const totalGasCost = txSteps.reduce((acc, step) => acc + step.gasCostEth, 0);
  const mintingCost = txSteps.find((s) => s.label === "Mint Property NFT").gasCostEth;
  const signingTxs = txSteps.filter((s) => s.label.includes("Sign"));
  const signingCost = avg(signingTxs.map((s) => s.gasCostEth), 6);
  const escrowOps = txSteps.filter((s) =>
    ["Authorize Escrow Transfer", "Deposit Buyer Payment", "Deposit Seller NFT", "Finalize Escrow"].includes(s.label)
  );
  const escrowCost = Number(escrowOps.reduce((acc, s) => acc + s.gasCostEth, 0).toFixed(6));
  const ownershipTransferCost = txSteps.find((s) => s.label === "Finalize Escrow").gasCostEth;

  const ipfsMetrics = await measureIpfsSurrogates(5);
  const onChainMetaMs = await measureOnChainMetadata(propertyNFT, 0, 5);
  ipfsMetrics.contractMetadataFetchMsAvg = Number(onChainMetaMs.toFixed(2));

  const apiLatency = await measureApiLatency(5, 5088);

  const report = {
    userSessions: {
      buyer: buyerAddr,
      seller: sellerAddr,
      autoLoginMs,
    },
    gasUsage: {
      totalGasUsed: totalGasUsed.toString(),
      totalGasCostEth: Number(totalGasCost.toFixed(6)),
      mintingCostEth: mintingCost,
      signingCostEthAvg: signingCost,
      escrowOpsCostEth: escrowCost,
      ownershipTransferCostEth: ownershipTransferCost,
      stampFeeCostEth: stampTx.gasCostEth,
    },
    timingsMs: txSteps.reduce((acc, step) => {
      acc[step.label] = step.durationMs;
      return acc;
    }, {}),
    ipfs: ipfsMetrics,
    apiLatency,
    blockchainTransactions: txSteps,
  };

  console.log("\n=== Transaction Metrics ===");
  console.table(
    txSteps.map((step) => ({
      Step: step.label,
      "Gas Used": step.gasUsed,
      "Gas Cost (ETH)": step.gasCostEth,
      "Duration (ms)": step.durationMs,
    }))
  );

  console.log("\n=== Performance Summary ===");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

