const path = require("path");
const fs = require("fs");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const Database = require("better-sqlite3");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const port = Number(process.env.PORT || 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${port}`);
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 3);
const usePostgres = Boolean(process.env.DATABASE_URL);

const rootDir = __dirname;
const dataDir = path.join(rootDir, "data");
const publicDir = path.join(rootDir, "public");
const imagesDir = path.join(rootDir, "imagenes");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(imagesDir, { recursive: true });

function nanoid(size = 10) {
  return crypto.randomBytes(Math.ceil(size * 0.75)).toString("base64url").slice(0, size);
}

function imageTitle(filename) {
  const knownTitles = {
    "45da640fbfe3b35a7f25a57bec44de05.jpg": "Looney Tunes live action",
    "dinosaurios-1024x576.jpg": "Dinosaurios remaster",
    "images.jpg": "El principe del rap: regreso a Bel-Air",
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

function createSqliteStore() {
  const db = new Database(path.join(dataDir, "netflix-nostalgia.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      format TEXT NOT NULL,
      reason TEXT NOT NULL,
      creator TEXT NOT NULL,
      country TEXT NOT NULL,
      reward TEXT NOT NULL,
      image_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS votes (
      proposal_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (proposal_id, voter_id),
      FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
    );
  `);

  return {
    async list(voterId) {
      const rows = db.prepare(`
        SELECT p.*, COUNT(v.voter_id) AS votes,
          EXISTS(SELECT 1 FROM votes own WHERE own.proposal_id = p.id AND own.voter_id = ?) AS has_voted
        FROM proposals p
        LEFT JOIN votes v ON v.proposal_id = p.id
        GROUP BY p.id
        ORDER BY votes DESC, p.created_at DESC
      `).all(voterId);
      return rows;
    },
    async insertProposal(proposal) {
      db.prepare(`
        INSERT INTO proposals (id, title, format, reason, creator, country, reward, image_url)
        VALUES (@id, @title, @format, @reason, @creator, @country, @reward, @image_url)
      `).run(proposal);
    },
    async getProposal(id) {
      return db.prepare("SELECT * FROM proposals WHERE id = ?").get(id);
    },
    async vote(proposalId, voterId) {
      const result = db.prepare("INSERT OR IGNORE INTO votes (proposal_id, voter_id) VALUES (?, ?)").run(proposalId, voterId);
      const votes = db.prepare("SELECT COUNT(*) AS total FROM votes WHERE proposal_id = ?").get(proposalId).total;
      return { votes, counted: result.changes === 1 };
    },
    async hasImage(imageUrl) {
      return Boolean(db.prepare("SELECT 1 FROM proposals WHERE image_url = ?").get(imageUrl));
    }
  };
}

function createPostgresStore() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
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

const store = usePostgres ? createPostgresStore() : createSqliteStore();
const ready = Promise.resolve(store.init?.()).then(() => seedFromImagesFolder());

async function seedFromImagesFolder() {
  const allowed = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
  const files = fs
    .readdirSync(imagesDir)
    .filter((file) => allowed.has(path.extname(file).toLowerCase()))
    .sort();

  for (const file of files) {
    const imageUrl = `/imagenes/${encodeURIComponent(file)}`;
    const exists = await store.hasImage(imageUrl);
    if (exists) continue;

    await store.insertProposal({
      id: nanoid(10),
      title: imageTitle(file),
      format: file.includes("dinosaurios") ? "Remasterizacion" : "Live action",
      reason: "Una idea nostalgica para que la comunidad vote si merece volver como original de Netflix.",
      creator: "Netflix fans",
      country: "Global",
      reward: "Cameo o dia de grabacion",
      image_url: imageUrl
    });
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

async function waitForStore(_req, _res, next) {
  try {
    await ready;
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
    res.json({ proposals: rows.map(proposalRow), database: usePostgres ? "postgres" : "sqlite-local" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/proposals", waitForStore, writeLimiter, ensureVoter, upload.single("image"), async (req, res, next) => {
  try {
    const title = clean(req.body.title, 80);
    const format = clean(req.body.format, 40);
    const reason = clean(req.body.reason, 260);
    const creator = clean(req.body.creator, 60);
    const country = clean(req.body.country, 60);
    const reward = clean(req.body.reward, 80) || "Cameo o visita al set";

    if (!title || !format || !reason || !creator || !country || !req.file) {
      return res.status(400).json({ error: "Completa todos los campos y sube una imagen." });
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
      return res.status(404).json({ error: "La propuesta no existe." });
    }

    const result = await store.vote(req.params.id, req.voterId);
    res.json({ votes: result.votes, hasVoted: true, counted: result.counted });
  } catch (error) {
    next(error);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `La imagen debe pesar maximo ${maxUploadMb}MB.` });
  }
  console.error(err);
  res.status(500).json({ error: "Algo fallo en el servidor." });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Netflix Nostalgia Vote listo en http://localhost:${port}`);
    console.log(`Base de datos: ${usePostgres ? "Postgres global" : "SQLite local"}`);
  });
}

module.exports = app;
