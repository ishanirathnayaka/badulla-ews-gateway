/**
 * Phase 5 - API Gateway (:4000)
 *
 * Single entry point for the three pillars, plus authentication, alert
 * acknowledgement, community reports, NGO registry administration and the
 * safe-location finder.
 *
 *   Pillar 1 (FastAPI :8000)  -> /api/risk
 *   Pillar 2 (Spring  :8081)  -> /api/severity, /api/alert/*, /api/sensors
 *   Pillar 3 (Sepolia + LP)   -> /api/allocation, /api/chain/*, /api/ngos
 */
import express from "express";
import cors from "cors";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

const PILLAR1 = process.env.PILLAR1_URL || "http://localhost:8000";
const PILLAR2 = process.env.PILLAR2_URL || "http://localhost:8081";
const PILLAR3_DIR = "D:/Research Finall EWS/pillar3-donation";

// ============================================================
// AUTHENTICATION
// ============================================================
const JWT_SECRET = process.env.JWT_SECRET || "badulla-ews-dev-secret-change-in-prod";

const USERS = [
  { username: "admin", role: "administrator", passwordHash: bcrypt.hashSync("admin123", 10) },
  { username: "operator", role: "operator", passwordHash: bcrypt.hashSync("operator123", 10) },
];

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body ?? {};
  const user = USERS.find((u) => u.username === username);
  if (!user || !bcrypt.compareSync(password || "", user.passwordHash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: "8h" });
  res.json({ token, username: user.username, role: user.role });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

// ============================================================
// SEVERITY LEVELS (shared)  — calibrated percentile thresholds
// ============================================================
const LEVELS = [
  { name: "CRITICAL", min: 0.1066 },
  { name: "RED", min: 0.0408 },
  { name: "ORANGE", min: 0.0146 },
  { name: "YELLOW", min: 0.0017 },
  { name: "GREEN", min: 0 },
];
const levelOf = (r) => LEVELS.find((l) => r >= l.min).name;
const UNSAFE_LEVELS = ["RED", "CRITICAL"];

async function riskByDivision() {
  try {
    const r = await fetch(`${PILLAR1}/predict`);
    const d = await r.json();
    const map = {};
    (d.divisions || []).forEach((x) => { map[x.division] = x.riskScore; });
    return map;
  } catch {
    return {};
  }
}

// ============================================================
// ALERT ACKNOWLEDGEMENTS (in-memory)
// ============================================================
const acknowledgements = new Map();

app.post("/api/alert/acknowledge", requireAuth, (req, res) => {
  const { alertId } = req.body ?? {};
  if (!alertId) return res.status(400).json({ error: "alertId required" });
  acknowledgements.set(alertId, {
    by: req.user.username,
    role: req.user.role,
    at: new Date().toISOString(),
  });
  res.json({ ok: true, alertId, ack: acknowledgements.get(alertId) });
});

app.get("/api/alert/acknowledgements", (_req, res) => {
  res.json(Object.fromEntries(acknowledgements));
});

// ============================================================
// COMMUNITY DISASTER REPORTS (in-memory)
// ============================================================
const communityReports = [];
let reportIdSeq = 1;

app.post("/api/reports", (req, res) => {
  const { division, description, latitude, longitude, reporterName } = req.body ?? {};
  if (!description || !division) {
    return res.status(400).json({ error: "division and description required" });
  }
  const report = {
    id: reportIdSeq++,
    division, description,
    latitude: latitude ?? null,
    longitude: longitude ?? null,
    reporterName: reporterName || "Anonymous",
    status: "PENDING",
    submittedAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
  };
  communityReports.unshift(report);
  res.json({ ok: true, report });
});

app.get("/api/reports", (_req, res) => {
  res.json({ count: communityReports.length, reports: communityReports });
});

app.post("/api/reports/:id/review", requireAuth, (req, res) => {
  const { status } = req.body ?? {};
  if (!["VERIFIED", "REJECTED"].includes(status)) {
    return res.status(400).json({ error: "status must be VERIFIED or REJECTED" });
  }
  const report = communityReports.find((r) => r.id === Number(req.params.id));
  if (!report) return res.status(404).json({ error: "report not found" });
  report.status = status;
  report.reviewedBy = req.user.username;
  report.reviewedAt = new Date().toISOString();
  res.json({ ok: true, report });
});

// ============================================================
// SAFE LOCATIONS (evacuation point finder)
// ============================================================
let SAFE_LOCATIONS = [];
try {
  const raw = JSON.parse(readFileSync("./safe_locations.json", "utf-8"));
  SAFE_LOCATIONS = raw.locations || [];
  console.log(`Loaded ${SAFE_LOCATIONS.length} candidate safe locations`);
} catch {
  console.warn("safe_locations.json not found - safe-location endpoints will return empty");
}

// A nearby shelter inside a dangerous division is worse than a further one in a calm division
const RISK_PENALTY = { GREEN: 1.0, YELLOW: 1.4, ORANGE: 2.5, RED: 6.0, CRITICAL: 12.0 };

// Capacity, sanitation and open floor space differ by building type; lower ranks better
const SHELTER_SUITABILITY = {
  "School": 1.0, "College": 1.0, "Community hall": 1.0,
  "Hospital": 1.2, "Government office": 1.4,
  "Place of worship": 1.6, "Public building": 1.8,
};
const SHELTER_KINDS = ["School", "College", "Community hall", "Hospital", "Government office"];
const KIND_RANK = Object.fromEntries(SHELTER_KINDS.map((k, i) => [k, i]));

// Monuments cannot shelter anyone
const NOT_A_SHELTER = /\b(statue|shrine|cross|bo tree|bodhi|dagoba|stupa|chaitya|monument|kovil stone)\b/i;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dp = rad(lat2 - lat1), dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingOf(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
            Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  const b = (deg(Math.atan2(y, x)) + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(b / 45) % 8];
}

// Nearest usable shelters for a given position
app.get("/api/safe-locations", async (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const limit = Math.min(parseInt(req.query.limit) || 5, 25);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: "lat and lng query parameters are required" });
  }

  const risks = await riskByDivision();
  const haveRisk = Object.keys(risks).length > 0;

  const ranked = SAFE_LOCATIONS
    .filter((loc) => !NOT_A_SHELTER.test(loc.name))
    .filter((loc) => {
      const risk = risks[loc.division];
      if (risk === undefined) return true;
      return !UNSAFE_LEVELS.includes(levelOf(risk));   // never route anyone into the hazard
    })
    .map((loc) => {
      const km = haversineKm(lat, lng, loc.latitude, loc.longitude);
      const risk = risks[loc.division];
      const level = risk === undefined ? null : levelOf(risk);
      const penalty = level ? RISK_PENALTY[level] : 1;
      const suitability = SHELTER_SUITABILITY[loc.kind] ?? 1.8;
      return {
        ...loc,
        distanceKm: Math.round(km * 100) / 100,
        direction: bearingOf(lat, lng, loc.latitude, loc.longitude),
        walkMinutes: Math.round((km / 4.5) * 60),
        divisionRisk: risk ?? null,
        divisionLevel: level,
        safetyScore: Math.round(km * penalty * suitability * 100) / 100,
      };
    })
    .sort((a, b) => a.safetyScore - b.safetyScore)
    .slice(0, limit);

  res.json({
    origin: { latitude: lat, longitude: lng },
    riskAware: haveRisk,
    totalCandidates: SAFE_LOCATIONS.length,
    locations: ranked,
  });
});

// Curated subset for map display
app.get("/api/safe-locations/all", async (req, res) => {
  const perDivision = Math.min(parseInt(req.query.perDivision) || 3, 10);
  const includeUnsafe = req.query.includeUnsafe === "true";

  const risks = await riskByDivision();
  const haveRisk = Object.keys(risks).length > 0;

  const byDivision = {};
  let excluded = 0;

  for (const loc of SAFE_LOCATIONS) {
    if (!SHELTER_KINDS.includes(loc.kind)) continue;
    if (NOT_A_SHELTER.test(loc.name)) continue;

    const risk = risks[loc.division];
    const level = risk === undefined ? null : levelOf(risk);
    const unsafe = level ? UNSAFE_LEVELS.includes(level) : false;
    if (unsafe && !includeUnsafe) { excluded++; continue; }

    (byDivision[loc.division] ||= []).push({
      ...loc,
      divisionRisk: risk ?? null,
      divisionLevel: level,
      currentlyUsable: !unsafe,
    });
  }

  const selected = [];
  for (const list of Object.values(byDivision)) {
    list.sort((a, b) =>
      (KIND_RANK[a.kind] - KIND_RANK[b.kind]) ||
      (a.kmFromDivisionCentre - b.kmFromDivisionCentre)
    );
    selected.push(...list.slice(0, perDivision));
  }

  res.json({
    count: selected.length,
    totalCandidates: SAFE_LOCATIONS.length,
    excludedInHighRiskDivisions: excluded,
    riskAware: haveRisk,
    perDivision,
    locations: selected,
  });
});

// ============================================================
// BLOCKCHAIN CONFIG
// ============================================================
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
const POOL = "0x1450021a60c15D3a001701F5cE24b17efD880b11";
const ENGINE = "0xF0FD568D4Cb6c7fcBBc1B0B254C22ef5BE18076B";
const REGISTRY = "0x2148f91B549b809e78dFB3B41CE5895e0D7041A9";

const POOL_ABI = [
  "function poolBalance() view returns (uint256)",
  "function totalDonated() view returns (uint256)",
  "function donationCount() view returns (uint256)",
  "function getDonation(uint256) view returns (address donor, uint256 amount, uint256 timestamp)",
];
const ENGINE_ABI = [
  "function proposalCount() view returns (uint256)",
  "function getProposal(uint256) view returns (uint256 amount, uint16[15] weightsBps, address[15] recipients, uint8 approvals, bool executed)",
];
const REGISTRY_ABI = [
  "function ngoCount() view returns (uint256)",
  "function ngoAt(uint256) view returns (address)",
  "function getNGO(address) view returns (string name, bool active, uint8[] divisions)",
  "function isVerified(address) view returns (bool)",
  "function registerNGO(address wallet, string name, uint8[] divisions)",
  "function deactivateNGO(address wallet)",
  "function reactivateNGO(address wallet)",
];

const pool = new ethers.Contract(POOL, POOL_ABI, provider);
const engine = new ethers.Contract(ENGINE, ENGINE_ABI, provider);

const adminSigner = process.env.DEPLOYER_PRIVATE_KEY
  ? new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider)
  : null;
const registryRead = new ethers.Contract(REGISTRY, REGISTRY_ABI, provider);
const registryWrite = adminSigner ? new ethers.Contract(REGISTRY, REGISTRY_ABI, adminSigner) : null;

const proxy = (base) => async (req, res) => {
  try {
    const r = await fetch(base + req.url.replace(/^\/api/, "/api/v1"), {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: ["POST", "PUT"].includes(req.method) ? JSON.stringify(req.body ?? {}) : undefined,
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: "upstream unavailable", detail: String(e) });
  }
};

// ============================================================
// PILLAR 1 - prediction
// ============================================================
app.get("/api/risk", async (_req, res) => {
  try {
    const r = await fetch(`${PILLAR1}/predict`);
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: "Pillar 1 unavailable", detail: String(e) });
  }
});

// ============================================================
// PILLAR 2 - EWS (proxied)
// ============================================================
for (const route of [
  "/api/severity/latest",
  "/api/alert/preview",
  "/api/alert/history",
  "/api/sensors/latest",
  "/api/status",
]) {
  app.get(route, proxy(PILLAR2));
}
app.post("/api/alert/dispatch", proxy(PILLAR2));
app.post("/api/risk/refresh", proxy(PILLAR2));

// ============================================================
// PILLAR 3 - LP allocation artefacts
// ============================================================
app.get("/api/allocation", (_req, res) => {
  try {
    res.json(JSON.parse(readFileSync(`${PILLAR3_DIR}/allocation/allocation_result.json`, "utf-8")));
  } catch {
    res.status(404).json({ error: "no allocation result yet" });
  }
});

app.get("/api/allocation/validation", (_req, res) => {
  try {
    const csv = readFileSync(`${PILLAR3_DIR}/allocation/ttd_runs.csv`, "utf-8").trim().split("\n").slice(1);
    const runs = csv.map((l) => {
      const [timestamp, proposalId, ttd] = l.split(",");
      return { timestamp, proposalId: +proposalId, ttdSeconds: +ttd };
    });
    const ttds = runs.map((r) => r.ttdSeconds);
    res.json({
      runs,
      mean: ttds.reduce((a, b) => a + b, 0) / ttds.length,
      min: Math.min(...ttds),
      max: Math.max(...ttds),
    });
  } catch {
    res.status(404).json({ error: "no validation runs yet" });
  }
});

// ============================================================
// PILLAR 3 - live on-chain reads
// ============================================================
app.get("/api/chain/summary", async (_req, res) => {
  try {
    const [balance, total, count, proposals] = await Promise.all([
      pool.poolBalance(), pool.totalDonated(), pool.donationCount(), engine.proposalCount(),
    ]);
    res.json({
      poolBalanceEth: ethers.formatEther(balance),
      totalDonatedEth: ethers.formatEther(total),
      donationCount: Number(count),
      proposalCount: Number(proposals),
      contracts: { pool: POOL, engine: ENGINE, registry: REGISTRY },
    });
  } catch (e) {
    res.status(502).json({ error: "Sepolia read failed", detail: String(e) });
  }
});

app.get("/api/chain/donations", async (_req, res) => {
  try {
    const count = Number(await pool.donationCount());
    const items = [];
    for (let i = Math.max(0, count - 20); i < count; i++) {
      const [donor, amount, timestamp] = await pool.getDonation(i);
      items.push({ index: i, donor, amountEth: ethers.formatEther(amount), timestamp: Number(timestamp) });
    }
    res.json({ count, donations: items.reverse() });
  } catch (e) {
    res.status(502).json({ error: "Sepolia read failed", detail: String(e) });
  }
});

app.get("/api/chain/proposals", async (_req, res) => {
  try {
    const count = Number(await engine.proposalCount());
    const items = [];
    for (let i = 0; i < count; i++) {
      const [amount, weightsBps, , approvals, executed] = await engine.getProposal(i);
      items.push({
        id: i,
        amountEth: ethers.formatEther(amount),
        weightsBps: weightsBps.map(Number),
        approvals: Number(approvals),
        executed,
      });
    }
    res.json({ count, proposals: items });
  } catch (e) {
    res.status(502).json({ error: "Sepolia read failed", detail: String(e) });
  }
});

// ============================================================
// PILLAR 3 - NGO registry management
// ============================================================
app.get("/api/ngos", async (_req, res) => {
  try {
    const count = Number(await registryRead.ngoCount());
    const ngos = [];
    for (let i = 0; i < count; i++) {
      const addr = await registryRead.ngoAt(i);
      const [name, active, divisions] = await registryRead.getNGO(addr);
      ngos.push({ address: addr, name, active, divisions: divisions.map(Number) });
    }
    res.json({ count, ngos });
  } catch (e) {
    res.status(502).json({ error: "registry read failed", detail: String(e) });
  }
});

app.post("/api/ngos", requireAuth, async (req, res) => {
  if (!registryWrite) return res.status(503).json({ error: "admin signer not configured (set DEPLOYER_PRIVATE_KEY)" });
  const { address, name, divisions } = req.body ?? {};
  if (!address || !name || !Array.isArray(divisions) || !divisions.length) {
    return res.status(400).json({ error: "address, name, divisions[] required" });
  }
  try {
    const tx = await registryWrite.registerNGO(address, name, divisions);
    await tx.wait();
    res.json({ ok: true, txHash: tx.hash });
  } catch (e) {
    res.status(500).json({ error: "registration failed", detail: String(e).slice(0, 200) });
  }
});

app.post("/api/ngos/:address/toggle", requireAuth, async (req, res) => {
  if (!registryWrite) return res.status(503).json({ error: "admin signer not configured (set DEPLOYER_PRIVATE_KEY)" });
  const { active } = req.body ?? {};
  try {
    const tx = active
      ? await registryWrite.reactivateNGO(req.params.address)
      : await registryWrite.deactivateNGO(req.params.address);
    await tx.wait();
    res.json({ ok: true, txHash: tx.hash });
  } catch (e) {
    res.status(500).json({ error: "toggle failed", detail: String(e).slice(0, 200) });
  }
});

// ============================================================
// HEALTH
// ============================================================
app.get("/api/health", (_req, res) =>
  res.json({ status: "UP", service: "phase5-gateway", ts: new Date().toISOString() })
);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API Gateway running on port ${PORT}`));