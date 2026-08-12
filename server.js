
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME";
const ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN || "";
const PUBLIC_BACKEND_URL = (process.env.PUBLIC_BACKEND_URL || "").replace(/\/+$/, "");
const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) {
  console.error("ERRO: DATABASE_URL não configurada.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && !DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false
});

const PACKS = Object.freeze({
  500:  { amount_cents: 799,  label: "R$ 7,99" },
  1000: { amount_cents: 1699, label: "R$ 16,99" },
  1500: { amount_cents: 3399, label: "R$ 33,99" },
  2000: { amount_cents: 6699, label: "R$ 66,99" }
});

function uid(prefix) {
  return prefix + "_" + crypto.randomUUID();
}

function userPublic(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    gems: Number(u.gems || 0)
  };
}

function sign(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      gems BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pix_orders (
      id TEXT PRIMARY KEY,
      payment_id TEXT UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gems INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      credited BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pix_orders_user_id
    ON pix_orders(user_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pix_orders_payment_id
    ON pix_orders(payment_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gem_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gem_transactions_user_id
    ON gem_transactions(user_id);
  `);
}

async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const payload = jwt.verify(token, JWT_SECRET);

    const { rows } = await pool.query(
      "SELECT * FROM users WHERE id = $1 LIMIT 1",
      [payload.sub]
    );
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ error: "Sessão inválida." });
    }

    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Faça login novamente." });
  }
}

async function mpFetch(path, options = {}) {
  if (!ACCESS_TOKEN) {
    throw new Error("MERCADOPAGO_ACCESS_TOKEN não configurado.");
  }

  const response = await fetch("https://api.mercadopago.com" + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + ACCESS_TOKEN,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || data.error || "Erro Mercado Pago");
  }

  return data;
}

async function creditApprovedPayment(payment) {
  const orderId = String(payment.external_reference || "");
  if (!orderId || String(payment.status) !== "approved") return false;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      "SELECT * FROM pix_orders WHERE id = $1 FOR UPDATE",
      [orderId]
    );

    const order = orderResult.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return false;
    }

    if (order.credited === true) {
      await client.query("COMMIT");
      return true;
    }

    if (String(order.payment_id) !== String(payment.id)) {
      await client.query("ROLLBACK");
      return false;
    }

    const expected = PACKS[Number(order.gems)];
    if (!expected) {
      throw new Error("Pacote do pedido não existe.");
    }

    const paidCents = Math.round(Number(payment.transaction_amount || 0) * 100);

    if (
      paidCents !== Number(order.amount_cents) ||
      paidCents !== Number(expected.amount_cents)
    ) {
      await client.query(
        `UPDATE pix_orders
         SET status = 'amount_mismatch', updated_at = NOW()
         WHERE id = $1`,
        [orderId]
      );
      await client.query("COMMIT");

      console.error("Valor divergente", {
        orderId,
        paidCents,
        expected: expected.amount_cents,
        gems: order.gems
      });

      return false;
    }

    const updateOrder = await client.query(
      `UPDATE pix_orders
       SET status = 'approved', credited = TRUE, updated_at = NOW()
       WHERE id = $1 AND credited = FALSE
       RETURNING id`,
      [orderId]
    );

    if (updateOrder.rowCount === 1) {
      await client.query(
        "UPDATE users SET gems = gems + $1 WHERE id = $2",
        [Number(order.gems), order.user_id]
      );

      console.log("Gemas creditadas", {
        orderId,
        userId: order.user_id,
        gems: order.gems,
        paymentId: payment.id
      });
    }

    await client.query("COMMIT");
    return true;

  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN
      ? process.env.FRONTEND_ORIGIN.split(",").map(v => v.trim())
      : true,
    credentials: false
  })
);

app.use(express.json({ limit: "1mb" }));

app.get("/health", async (req, res) => {
  let database = false;

  try {
    await pool.query("SELECT 1");
    database = true;
  } catch (_) {}

  res.json({
    online: true,
    service: "Empire Forge API",
    version: "35.3-wallet",
    pixConfigured: !!ACCESS_TOKEN,
    database,
    databaseType: "postgresql",
    packs: [500, 1000, 1500, 2000]
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim().slice(0, 30);
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = String(req.body.phone || "").replace(/\D/g, "");
    const password = String(req.body.password || "");

    if (
      name.length < 2 ||
      !email.includes("@") ||
      phone.length < 10 ||
      password.length < 6
    ) {
      return res.status(400).json({ error: "Dados de cadastro inválidos." });
    }

    const exists = await pool.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1",
      [email]
    );

    if (exists.rowCount) {
      return res.status(409).json({ error: "E-mail já cadastrado." });
    }

    const id = uid("EF");
    const hash = await bcrypt.hash(password, 12);

    const inserted = await pool.query(
      `INSERT INTO users(id,name,email,phone,password_hash)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [id, name, email, phone, hash]
    );

    const user = inserted.rows[0];

    res.json({
      token: sign(user),
      user: userPublic(user)
    });

  } catch (e) {
    console.error(e);

    if (e.code === "23505") {
      return res.status(409).json({ error: "E-mail já cadastrado." });
    }

    res.status(500).json({ error: "Erro ao cadastrar." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1 LIMIT 1",
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "E-mail ou senha incorretos." });
    }

    res.json({
      token: sign(user),
      user: userPublic(user)
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao entrar." });
  }
});

app.get("/api/auth/me", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM users WHERE id = $1 LIMIT 1",
    [req.user.id]
  );

  res.json({ user: userPublic(result.rows[0]) });
});

app.get("/api/wallet", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT id,name,email,gems FROM users WHERE id = $1 LIMIT 1",
    [req.user.id]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  res.set("Cache-Control", "no-store");

  const u = result.rows[0];

  res.json({
    id: u.id,
    name: u.name,
    email: u.email,
    gems: Number(u.gems || 0)
  });
});


app.post("/api/wallet/spend", auth, async (req, res) => {
  const amount = Math.floor(Number(req.body?.amount || 0));
  const reason = String(req.body?.reason || "game_spend").slice(0, 80);
  const transactionId = String(req.body?.transactionId || "").trim();

  if (!Number.isInteger(amount) || amount <= 0 || amount > 100000) {
    return res.status(400).json({ error: "Quantidade de gemas inválida." });
  }
  if (!transactionId || transactionId.length > 120) {
    return res.status(400).json({ error: "transactionId obrigatório." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT amount FROM gem_transactions WHERE id = $1 AND user_id = $2 LIMIT 1",
      [transactionId, req.user.id]
    );
    if (existing.rows[0]) {
      const u = await client.query("SELECT gems FROM users WHERE id = $1", [req.user.id]);
      await client.query("COMMIT");
      return res.json({ ok: true, duplicate: true, spent: Number(existing.rows[0].amount), balance: Number(u.rows[0]?.gems || 0) });
    }

    const updated = await client.query(
      `UPDATE users
       SET gems = gems - $1
       WHERE id = $2 AND gems >= $1
       RETURNING gems`,
      [amount, req.user.id]
    );

    if (!updated.rows[0]) {
      const current = await client.query("SELECT gems FROM users WHERE id = $1", [req.user.id]);
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Saldo de gemas insuficiente.",
        balance: Number(current.rows[0]?.gems || 0)
      });
    }

    await client.query(
      "INSERT INTO gem_transactions (id,user_id,amount,reason) VALUES ($1,$2,$3,$4)",
      [transactionId, req.user.id, amount, reason]
    );

    await client.query("COMMIT");
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, spent: amount, balance: Number(updated.rows[0].gems) });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("wallet spend error", e);
    return res.status(500).json({ error: "Não foi possível descontar as gemas." });
  } finally {
    client.release();
  }
});

app.get("/api/store/packs", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    500:  { gems: 500,  amountCents: 799,  price: "R$ 7,99" },
    1000: { gems: 1000, amountCents: 1699, price: "R$ 16,99" },
    1500: { gems: 1500, amountCents: 3399, price: "R$ 33,99" },
    2000: { gems: 2000, amountCents: 6699, price: "R$ 66,99" }
  });
});

app.post("/api/pix/create", auth, async (req, res) => {
  try {
    const gems = Number(req.body.gems);
    const pack = PACKS[gems];

    if (!pack) {
      return res.status(400).json({ error: "Pacote inválido." });
    }

    if (!PUBLIC_BACKEND_URL) {
      return res.status(500).json({
        error: "PUBLIC_BACKEND_URL não configurada."
      });
    }

    const cents = pack.amount_cents;
    const orderId = uid("ORDER");

    const payload = {
      transaction_amount: cents / 100,
      description: `Empire Forge - ${gems} gemas`,
      payment_method_id: "pix",
      payer: { email: req.user.email },
      external_reference: orderId,
      notification_url: PUBLIC_BACKEND_URL + "/api/pix/webhook"
    };

    const payment = await mpFetch("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": orderId },
      body: JSON.stringify(payload)
    });

    await pool.query(
      `INSERT INTO pix_orders
       (id,payment_id,user_id,gems,amount_cents,status)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        orderId,
        String(payment.id),
        req.user.id,
        gems,
        cents,
        String(payment.status || "pending")
      ]
    );

    const transactionData =
      payment.point_of_interaction?.transaction_data || {};

    res.json({
      orderId,
      paymentId: String(payment.id),
      status: payment.status || "pending",
      qrCode: transactionData.qr_code || "",
      qrBase64: transactionData.qr_code_base64 || ""
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: e.message || "Erro ao gerar Pix."
    });
  }
});

app.post("/api/pix/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const paymentId = String(
      req.body?.data?.id ||
      req.query?.["data.id"] ||
      req.query?.id ||
      ""
    );

    if (!paymentId) return;

    const payment = await mpFetch(
      "/v1/payments/" + encodeURIComponent(paymentId),
      { method: "GET" }
    );

    await pool.query(
      `UPDATE pix_orders
       SET status = $1, updated_at = NOW()
       WHERE payment_id = $2`,
      [String(payment.status || "pending"), String(payment.id)]
    );

    await creditApprovedPayment(payment);

  } catch (e) {
    console.error("webhook", e);
  }
});

app.get("/api/pix/status/:paymentId", auth, async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const id = String(req.params.paymentId);

    let orderResult = await pool.query(
      `SELECT * FROM pix_orders
       WHERE payment_id = $1 AND user_id = $2
       LIMIT 1`,
      [id, req.user.id]
    );

    let order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({
        error: "Pagamento não encontrado."
      });
    }

    if (ACCESS_TOKEN && order.status !== "approved") {
      try {
        const payment = await mpFetch(
          "/v1/payments/" + encodeURIComponent(id),
          { method: "GET" }
        );

        await pool.query(
          `UPDATE pix_orders
           SET status = $1, updated_at = NOW()
           WHERE payment_id = $2`,
          [String(payment.status || "pending"), id]
        );

        await creditApprovedPayment(payment);

      } catch (_) {}
    }

    orderResult = await pool.query(
      `SELECT * FROM pix_orders
       WHERE payment_id = $1 AND user_id = $2
       LIMIT 1`,
      [id, req.user.id]
    );

    order = orderResult.rows[0];

    const userResult = await pool.query(
      "SELECT gems FROM users WHERE id = $1 LIMIT 1",
      [req.user.id]
    );

    const user = userResult.rows[0];

    res.json({
      status: order.status,
      gems: Number(order.gems),
      balance: Number(user?.gems || 0),
      credited: order.credited === true
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Erro ao consultar pagamento."
    });
  }
});

async function start() {
  try {
    await initDb();
    console.log("PostgreSQL conectado e tabelas prontas.");

    app.listen(PORT, () => {
      console.log("Empire Forge API V35.2 PostgreSQL online na porta", PORT);
    });

  } catch (e) {
    console.error("Falha ao iniciar banco PostgreSQL:", e);
    process.exit(1);
  }
}

start();
