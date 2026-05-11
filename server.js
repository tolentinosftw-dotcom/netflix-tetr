const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const port = Number(process.env.PORT || 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${port}`);
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 3);
const rawDatabaseUrl = process.env.DATABASE_URL || "";
const databaseUrl = normalizeDatabaseUrl(rawDatabaseUrl);
const hasPlaceholderDatabaseUrl = /user:password@host|\[YOUR-PASSWORD\]/i.test(rawDatabaseUrl);
const usePostgres = Boolean(databaseUrl) && !hasPlaceholderDatabaseUrl;
const isVercel = Boolean(process.env.VERCEL);

const rootDir = __dirname;
const dataDir = isVercel ? path.join(os.tmpdir(), "netflix-tetr-data") : path.join(rootDir, "data");
const publicDir = path.join(rootDir, "public");
const imagesDir = path.join(rootDir, "imagenes");

fs.mkdirSync(dataDir, { recursive: true });
if (!isVercel) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

function nanoid(size = 10) {
  return crypto.randomBytes(Math.ceil(size * 0.75)).toString("base64url").slice(0, size);
}

function normalizeDatabaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/:\[([^\]]+)\]@/, (_match, password) => `:${encodeURIComponent(password)}@`);
}

function imageTitle(filename) {
  const knownTitles = {
    "45da640fbfe3b35a7f25a57bec44de05.jpg": "Looney Tunes live action",
    "dinosaurios-1024x576.jpg": "Dinosaurs remaster",
    "images.jpg": "The Fresh Prince of Bel-Air comeback",
    "MV5BN2VlNTdlMzQtYzE5OC00YmYwLTgyZTItYjEzMWY0ZDNjMTJhXkEyXkFqcGc@._V1_.jpg": "Dragon Ball Z live action"
  };

  if (knownTitles[filename]) return knownTitles[filename];
  return path
    .basename(filename, path.extname(filename))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function createLocalStore() {
  const localDbPath = path.join(dataDir, "local-store.json");

  function read() {
    if (!fs.existsSync(localDbPath)) {
      return { proposals: [], votes: [] };
    }
    return JSON.parse(fs.readFileSync(localDbPath, "utf8"));
  }

  function write(data) {
    fs.writeFileSync(localDbPath, JSON.stringify(data, null, 2));
  }

  return {
    async list(voterId) {
      const data = read();
      return data.proposals
        .map((proposal) => {
          const votes = data.votes.filter((vote) => vote.proposal_id === proposal.id);
          return {
            ...proposal,
            votes: votes.length,
            has_voted: votes.some((vote) => vote.voter_id === voterId)
          };
        })
        .sort((a, b) => b.votes - a.votes || new Date(b.created_at) - new Date(a.created_at));
    },
    async insertProposal(proposal) {
      const data = read();
      data.proposals.push({ ...proposal, created_at: new Date().toISOString() });
      write(data);
    },
    async updateSeedProposal(proposal) {
      const data = read();
      const index = data.proposals.findIndex((item) => item.image_url === proposal.image_url);
      if (index >= 0) {
        data.proposals[index] = { ...data.proposals[index], ...proposal };
        write(data);
      }
    },
    async getProposal(id) {
      return read().proposals.find((proposal) => proposal.id === id);
    },
    async vote(proposalId, voterId) {
      const data = read();
      const exists = data.votes.some((vote) => vote.proposal_id === proposalId && vote.voter_id === voterId);
      if (!exists) {
        data.votes.push({ proposal_id: proposalId, voter_id: voterId, created_at: new Date().toISOString() });
        write(data);
      }
      const votes = data.votes.filter((vote) => vote.proposal_id === proposalId).length;
      return { votes, counted: !exists };
    },
    async hasImage(imageUrl) {
      return read().proposals.some((proposal) => proposal.image_url === imageUrl);
    }
  };
}

function createPostgresStore() {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
  });

  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS proposals (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          format TEXT NOT NULL,
          reason TEXT NOT NULL,
          creator TEXT NOT NULL,
          country TEXT NOT NULL,
          reward TEXT NOT NULL,
          image_url TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS votes (
          proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
          voter_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (proposal_id, voter_id)
        );
      `);
    },
    async list(voterId) {
      const { rows } = await pool.query(`
        SELECT p.*, COUNT(v.voter_id)::int AS votes,
          EXISTS(SELECT 1 FROM votes own WHERE own.proposal_id = p.id AND own.voter_id = $1) AS has_voted
        FROM proposals p
        LEFT JOIN votes v ON v.proposal_id = p.id
        GROUP BY p.id
        ORDER BY votes DESC, p.created_at DESC
      `, [voterId]);
      return rows;
    },
    async insertProposal(proposal) {
      await pool.query(`
        INSERT INTO proposals (id, title, format, reason, creator, country, reward, image_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        proposal.id,
        proposal.title,
        proposal.format,
        proposal.reason,
        proposal.creator,
        proposal.country,
        proposal.reward,
        proposal.image_url
      ]);
    },
    async updateSeedProposal(proposal) {
      await pool.query(`
        UPDATE proposals
        SET title = $1, format = $2, reason = $3, creator = $4, country = $5, reward = $6
        WHERE image_url = $7
      `, [
        proposal.title,
        proposal.format,
        proposal.reason,
        proposal.creator,
        proposal.country,
        proposal.reward,
        proposal.image_url
      ]);
    },
    async getProposal(id) {
      const { rows } = await pool.query("SELECT * FROM proposals WHERE id = $1", [id]);
      return rows[0];
    },
    async vote(proposalId, voterId) {
      const result = await pool.query("INSERT INTO votes (proposal_id, voter_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [proposalId, voterId]);
      const { rows } = await pool.query("SELECT COUNT(*)::int AS total FROM votes WHERE proposal_id = $1", [proposalId]);
      return { votes: rows[0].total, counted: result.rowCount === 1 };
    },
    async hasImage(imageUrl) {
      const { rows } = await pool.query("SELECT 1 FROM proposals WHERE image_url = $1 LIMIT 1", [imageUrl]);
      return rows.length > 0;
    }
  };
}

const store = usePostgres ? createPostgresStore() : createLocalStore();
let ready;

function ensureStoreReady() {
  if (!ready) {
    ready = Promise.resolve(store.init?.()).then(() => seedFromImagesFolder());
  }
  return ready;
}

async function seedFromImagesFolder() {
  const allowed = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
  const files = fs
    .readdirSync(imagesDir)
    .filter((file) => allowed.has(path.extname(file).toLowerCase()))
    .sort();

  for (const file of files) {
    const imageUrl = `/imagenes/${encodeURIComponent(file)}`;
    const proposal = {
      id: nanoid(10),
      title: imageTitle(file),
      format: file.includes("dinosaurios") ? "Remaster" : "Live action",
      reason: "A nostalgic idea for the community to vote on as a potential Netflix original comeback.",
      creator: "Netflix fans",
      country: "Global",
      reward: "Cameo or filming day visit",
      image_url: imageUrl
    };
    const exists = await store.hasImage(imageUrl);
    if (exists) {
      await store.updateSeedProposal?.(proposal);
      continue;
    }

    await store.insertProposal(proposal);
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
    cb(null, allowed.has(file.mimetype));
  }
});

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(cors({ origin: true, credentials: true }));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use("/imagenes", express.static(imagesDir, { maxAge: "30d", immutable: true }));
app.use(express.static(publicDir));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 80,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

app.use("/api", apiLimiter);

function safeError(error) {
  return {
    message: String(error?.message || "Unknown error").replace(databaseUrl, "[DATABASE_URL]"),
    code: error?.code || null
  };
}

async function waitForStore(_req, _res, next) {
  try {
    if (hasPlaceholderDatabaseUrl) {
      return next(new Error("DATABASE_URL still has the example value. Paste the real Supabase Transaction pooler URL in Vercel."));
    }
    await ensureStoreReady();
    next();
  } catch (error) {
    next(error);
  }
}

function ensureVoter(req, res, next) {
  let voterId = req.cookies.voter_id;
  if (!voterId || !/^[a-zA-Z0-9_-]{12,32}$/.test(voterId)) {
    voterId = nanoid(16);
    res.cookie("voter_id", voterId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 365
    });
  }
  req.voterId = voterId;
  next();
}

function clean(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function proposalRow(row) {
  return {
    id: row.id,
    title: row.title,
    format: row.format,
    reason: row.reason,
    creator: row.creator,
    country: row.country,
    reward: row.reward,
    imageUrl: row.image_url,
    createdAt: row.created_at,
    votes: Number(row.votes || 0),
    hasVoted: Boolean(row.has_voted),
    shareUrl: `${publicBaseUrl}/?idea=${row.id}`
  };
}

app.get("/api/proposals", waitForStore, ensureVoter, async (req, res, next) => {
  try {
    const rows = await store.list(req.voterId);
    res.json({ proposals: rows.map(proposalRow), database: usePostgres ? "postgres" : "json-local" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/health", async (_req, res) => {
  const health = {
    ok: true,
    database: usePostgres ? "postgres" : "json-local",
    hasDatabaseUrl: Boolean(rawDatabaseUrl),
    hasPlaceholderDatabaseUrl,
    vercel: isVercel
  };

  try {
    await ensureStoreReady();
    res.json(health);
  } catch (error) {
    res.status(500).json({ ...health, ok: false, error: safeError(error) });
  }
});

app.post("/api/proposals", waitForStore, writeLimiter, ensureVoter, upload.single("image"), async (req, res, next) => {
  try {
    const title = clean(req.body.title, 80);
    const format = clean(req.body.format, 40);
    const reason = clean(req.body.reason, 260);
    const creator = clean(req.body.creator, 60);
    const country = clean(req.body.country, 60);
    const reward = clean(req.body.reward, 80) || "Cameo or filming day visit";

    if (!title || !format || !reason || !creator || !country || !req.file) {
      return res.status(400).json({ error: "Complete all fields and upload an image." });
    }

    const id = nanoid(10);
    const imageUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    const proposal = {
      id,
      title,
      format,
      reason,
      creator,
      country,
      reward,
      image_url: imageUrl
    };

    await store.insertProposal(proposal);
    res.status(201).json({ proposal: proposalRow({ ...proposal, votes: 0, has_voted: false, created_at: new Date().toISOString() }) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/proposals/:id/vote", waitForStore, writeLimiter, ensureVoter, async (req, res, next) => {
  try {
    const proposal = await store.getProposal(req.params.id);
    if (!proposal) {
      return res.status(404).json({ error: "The proposal does not exist." });
    }

    const result = await store.vote(req.params.id, req.voterId);
    res.json({ votes: result.votes, hasVoted: true, counted: result.counted });
  } catch (error) {
    next(error);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `The image must be ${maxUploadMb}MB or smaller.` });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server.", detail: safeError(err) });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Netflix Nostalgia Vote ready at http://localhost:${port}`);
    console.log(`Database: ${usePostgres ? "Global Postgres" : "Local JSON"}`);
  });
}

module.exports = app;
