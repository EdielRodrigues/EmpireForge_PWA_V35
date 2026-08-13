
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
  70: { amount_cents: 490, label: "R$ 4,90" },
  170: { amount_cents: 1590, label: "R$ 15,90" },
  270: { amount_cents: 2590, label: "R$ 25,90" },
  370: { amount_cents: 3590, label: "R$ 35,90" },
  470: { amount_cents: 4590, label: "R$ 45,90" },
  670: { amount_cents: 5090, label: "R$ 50,90" }
});
const RESOURCE_PACKS = Object.freeze({
  gold:   { resource_type:"gold",   resource_amount:10000, amount_cents:299, label:"R$ 2,99" },
  elixir: { resource_type:"elixir", resource_amount:10000, amount_cents:399, label:"R$ 3,99" }
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
    gems: Number(u.gems || 0),
    gold: Number(u.gold || 0),
    elixir: Number(u.elixir || 0)
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

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gold BIGINT NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS elixir BIGINT NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS game_state JSONB;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_state_backups (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_game_state_backups_user_created
    ON game_state_backups(user_id, created_at DESC);
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

  await pool.query(`ALTER TABLE pix_orders ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'gems';`);
  await pool.query(`ALTER TABLE pix_orders ADD COLUMN IF NOT EXISTS resource_type TEXT;`);
  await pool.query(`ALTER TABLE pix_orders ADD COLUMN IF NOT EXISTS resource_amount INTEGER NOT NULL DEFAULT 0;`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pix_orders_user_id
    ON pix_orders(user_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pix_orders_payment_id
    ON pix_orders(payment_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS resource_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_resource_transactions_user_id
    ON resource_transactions(user_id);
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
    const { rows } = await client.query(
      "SELECT * FROM pix_orders WHERE id = $1 FOR UPDATE",
      [orderId]
    );
    const order = rows[0];
    if (!order) { await client.query("ROLLBACK"); return false; }
    if (order.credited === true) { await client.query("COMMIT"); return true; }
    if (String(order.payment_id) !== String(payment.id)) { await client.query("ROLLBACK"); return false; }

    const paidCents = Math.round(Number(payment.transaction_amount || 0) * 100);
    let expectedCents = 0;

    if (order.order_type === "resource") {
      const rp = RESOURCE_PACKS[String(order.resource_type || "")];
      if (!rp || Number(order.resource_amount) !== Number(rp.resource_amount)) {
        throw new Error("Pacote de recurso inválido.");
      }
      expectedCents = Number(rp.amount_cents);
    } else {
      const gp = PACKS[Number(order.gems)];
      if (!gp) throw new Error("Pacote de gemas inválido.");
      expectedCents = Number(gp.amount_cents);
    }

    if (paidCents !== Number(order.amount_cents) || paidCents !== expectedCents) {
      await client.query(
        "UPDATE pix_orders SET status='amount_mismatch',updated_at=NOW() WHERE id=$1",
        [orderId]
      );
      await client.query("COMMIT");
      console.error("Valor divergente", {orderId,paidCents,expectedCents});
      return false;
    }

    const mark = await client.query(
      `UPDATE pix_orders SET status='approved',credited=TRUE,updated_at=NOW()
       WHERE id=$1 AND credited=FALSE RETURNING id`,
      [orderId]
    );

    if (mark.rowCount === 1) {
      if (order.order_type === "resource") {
        if (order.resource_type === "gold") {
          await client.query("UPDATE users SET gold=gold+$1 WHERE id=$2",
            [Number(order.resource_amount),order.user_id]);
        } else if (order.resource_type === "elixir") {
          await client.query("UPDATE users SET elixir=elixir+$1 WHERE id=$2",
            [Number(order.resource_amount),order.user_id]);
        } else {
          throw new Error("Tipo de recurso inválido.");
        }
        console.log("Recurso creditado", {
          orderId,userId:order.user_id,type:order.resource_type,amount:order.resource_amount
        });
      } else {
        await client.query("UPDATE users SET gems=gems+$1 WHERE id=$2",
          [Number(order.gems),order.user_id]);
        console.log("Gemas creditadas", {orderId,userId:order.user_id,gems:order.gems});
      }
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
    version: "35.10-real-matchmaking-save",
    pixConfigured: !!ACCESS_TOKEN,
    database,
    databaseType: "postgresql",
    packs: [70,170,270,370,470,670], resourcePacks: {gold:299,elixir:399}
  });
});


function newPlayerGameState(name) {
  return {
    version: 30,
    mapVersion: 30,
    playerName: String(name || "Jogador").slice(0,30),
    gold: 0,
    elixir: 0,
    trophies: 0,
    xp: 0,
    level: 1,
    army: [],
    queue: [],
    stats: { collected:0, trained:0, wins:0 },
    claimed: { collect:false, train:false, win:false },
    lastChest: 0,
    shieldUntil: 0,
    lab: { sword:1, archer:1, giant:1, mage:1 },
    labQueue: null,
    hero: { level:1, xp:0 },
    clan: { name:"Sem clã", points:0 },
    campaign: 1,
    season: { xp:0, claimed:0 },
    achievements: {},
    war: { wins:0, last:0 },
    streak: { days:1, last:Date.now() },
    buildings: [
      {id:"town1",type:"town",x:8,y:5,level:1,readyAt:0},
      {id:"gm1",type:"goldmine",x:6,y:3,level:1,readyAt:0,stored:0},
      {id:"em1",type:"elixirmine",x:11,y:3,level:1,readyAt:0,stored:0},
      {id:"can1",type:"cannon",x:6,y:8,level:1,readyAt:0},
      {id:"tow1",type:"tower",x:11,y:8,level:1,readyAt:0},
      {id:"bar1",type:"barracks",x:8,y:8,level:1,readyAt:0},
      {id:"camp1",type:"camp",x:10,y:8,level:1,readyAt:0}
    ],
    lastTick: Date.now(),
    updatedAt: Date.now()
  };
}

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

    const freshState = newPlayerGameState(name);
    const inserted = await pool.query(
      `INSERT INTO users(id,name,email,phone,password_hash,game_state,last_seen)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,NOW())
       RETURNING *`,
      [id, name, email, phone, hash, JSON.stringify(freshState)]
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


app.post("/api/resources/add", auth, async (req, res) => {
  const resource = String(req.body?.resource || "").toLowerCase();
  const amount = Math.floor(Number(req.body?.amount || 0));
  const reason = String(req.body?.reason || "production").slice(0,80);
  const transactionId = String(req.body?.transactionId || "").trim();

  if (!["gold","elixir"].includes(resource)) {
    return res.status(400).json({error:"Recurso inválido."});
  }
  if (!Number.isInteger(amount) || amount <= 0 || amount > 100000000) {
    return res.status(400).json({error:"Quantidade inválida."});
  }
  if (!transactionId || transactionId.length > 120) {
    return res.status(400).json({error:"transactionId obrigatório."});
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT amount,resource_type FROM resource_transactions WHERE id=$1 AND user_id=$2 LIMIT 1",
      [transactionId, req.user.id]
    );

    if (existing.rows[0]) {
      const u = await client.query("SELECT gold,elixir FROM users WHERE id=$1",[req.user.id]);
      await client.query("COMMIT");
      return res.json({
        ok:true,
        duplicate:true,
        gold:Number(u.rows[0]?.gold||0),
        elixir:Number(u.rows[0]?.elixir||0)
      });
    }

    const column = resource === "gold" ? "gold" : "elixir";
    const updated = await client.query(
      `UPDATE users SET ${column}=COALESCE(${column},0)+$1 WHERE id=$2 RETURNING gold,elixir`,
      [amount, req.user.id]
    );

    await client.query(
      "INSERT INTO resource_transactions(id,user_id,resource_type,amount,reason) VALUES($1,$2,$3,$4,$5)",
      [transactionId, req.user.id, resource, amount, reason]
    );

    await client.query("COMMIT");
    return res.json({
      ok:true,
      gold:Number(updated.rows[0]?.gold||0),
      elixir:Number(updated.rows[0]?.elixir||0)
    });

  } catch(e) {
    await client.query("ROLLBACK");
    console.error("resource add error",e);
    return res.status(500).json({error:"Não foi possível salvar o recurso."});
  } finally {
    client.release();
  }
});


function sanitizeGameState(input) {
  const x = input && typeof input === "object" ? input : {};
  const n = (v,d=0) => Number.isFinite(Number(v)) ? Number(v) : d;
  const bool = v => !!v;
  const obj = v => v && typeof v === "object" && !Array.isArray(v) ? v : {};

  const buildings = Array.isArray(x.buildings) ? x.buildings.slice(0,300).map(b => ({
    id:String(b?.id||"").slice(0,80),
    type:String(b?.type||"").slice(0,40),
    x:n(b?.x,0), y:n(b?.y,0),
    level:Math.max(1,n(b?.level,1)),
    readyAt:Math.max(0,n(b?.readyAt,0)),
    stored:Math.max(0,n(b?.stored,0))
  })) : [];

  const queue = Array.isArray(x.queue) ? x.queue.slice(0,100).map(q=>({
    id:String(q?.id||"").slice(0,80),
    type:String(q?.type||"").slice(0,40),
    readyAt:Math.max(0,n(q?.readyAt,0)),
    amount:Math.max(0,n(q?.amount,0))
  })) : [];

  const army = Array.isArray(x.army)
    ? x.army.slice(0,500).map(v=>String(v||"").slice(0,40)).filter(Boolean)
    : [];

  const labIn=obj(x.lab), statsIn=obj(x.stats), claimedIn=obj(x.claimed);
  const seasonIn=obj(x.season), heroIn=obj(x.hero), clanIn=obj(x.clan);
  const warIn=obj(x.war), streakIn=obj(x.streak);

  return {
    version:Math.max(1,n(x.version,30)),
    mapVersion:Math.max(30,n(x.mapVersion,30)),
    playerName:String(x.playerName||"Jogador").slice(0,30),
    gold:Math.max(0,n(x.gold,0)),
    elixir:Math.max(0,n(x.elixir,0)),
    trophies:Math.max(0,n(x.trophies,0)),
    xp:Math.max(0,n(x.xp,0)),
    level:Math.max(1,n(x.level,1)),
    army, queue, buildings,
    selected:null,
    editMode:false,
    shopCat:String(x.shopCat||"recursos").slice(0,30),
    stats:{
      collected:Math.max(0,n(statsIn.collected,0)),
      trained:Math.max(0,n(statsIn.trained,0)),
      wins:Math.max(0,n(statsIn.wins,0))
    },
    claimed:{
      collect:bool(claimedIn.collect),
      train:bool(claimedIn.train),
      win:bool(claimedIn.win)
    },
    lastChest:Math.max(0,n(x.lastChest,0)),
    shieldUntil:Math.max(0,n(x.shieldUntil,0)),
    lab:{
      sword:Math.max(1,n(labIn.sword,1)),
      archer:Math.max(1,n(labIn.archer,1)),
      giant:Math.max(1,n(labIn.giant,1)),
      mage:Math.max(1,n(labIn.mage,1))
    },
    labQueue:x.labQueue && typeof x.labQueue==="object" ? x.labQueue : null,
    hero:{level:Math.max(1,n(heroIn.level,1)),xp:Math.max(0,n(heroIn.xp,0))},
    clan:{name:String(clanIn.name||"Sem clã").slice(0,40),points:Math.max(0,n(clanIn.points,0))},
    campaign:Math.max(1,n(x.campaign,1)),
    season:{xp:Math.max(0,n(seasonIn.xp,0)),claimed:Math.max(0,n(seasonIn.claimed,0))},
    achievements:obj(x.achievements),
    war:{wins:Math.max(0,n(warIn.wins,0)),last:Math.max(0,n(warIn.last,0))},
    streak:{days:Math.max(1,n(streakIn.days,1)),last:Math.max(0,n(streakIn.last,Date.now()))},
    lastTick:Math.max(0,n(x.lastTick,Date.now())),
    updatedAt:Date.now()
  };
}

app.post("/api/game/state", auth, async (req,res) => {
  try {
    const gameState=sanitizeGameState(req.body?.state);

    // Backup automático no máximo uma vez a cada 10 minutos por conta.
    await pool.query(`
      INSERT INTO game_state_backups(user_id,game_state)
      SELECT $1,$2::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM game_state_backups
        WHERE user_id=$1 AND created_at > NOW() - INTERVAL '10 minutes'
      )
    `,[req.user.id,JSON.stringify(gameState)]);

    await pool.query(`
      DELETE FROM game_state_backups
      WHERE user_id=$1 AND id NOT IN (
        SELECT id FROM game_state_backups
        WHERE user_id=$1
        ORDER BY created_at DESC
        LIMIT 12
      )
    `,[req.user.id]);

    await pool.query(
      "UPDATE users SET game_state=$1::jsonb,last_seen=NOW() WHERE id=$2",
      [JSON.stringify(gameState),req.user.id]
    );

    res.json({ok:true,updatedAt:gameState.updatedAt,backup:true});
  } catch(e) {
    console.error("save game state",e);
    res.status(500).json({error:"Não foi possível salvar a vila."});
  }
});

app.get("/api/game/state", auth, async (req,res) => {
  try {
    const {rows}=await pool.query(
      "SELECT game_state,last_seen FROM users WHERE id=$1 LIMIT 1",
      [req.user.id]
    );
    res.set("Cache-Control","no-store");
    res.json({state:rows[0]?.game_state||null,lastSeen:rows[0]?.last_seen||null});
  } catch(e) {
    res.status(500).json({error:"Não foi possível carregar a vila."});
  }
});


app.post("/api/game/reset", auth, async (req,res) => {
  try{
    const q=await pool.query("SELECT name FROM users WHERE id=$1 LIMIT 1",[req.user.id]);
    const name=q.rows[0]?.name||"Jogador";
    const fresh=newPlayerGameState(name);

    await pool.query(
      "UPDATE users SET game_state=$1::jsonb,gems=0,gold=0,elixir=0,last_seen=NOW() WHERE id=$2",
      [JSON.stringify(fresh),req.user.id]
    );

    await pool.query(
      "INSERT INTO game_state_backups(user_id,game_state) VALUES($1,$2::jsonb)",
      [req.user.id,JSON.stringify(fresh)]
    );

    res.json({ok:true,state:fresh});
  }catch(e){
    console.error("reset game",e);
    res.status(500).json({error:"Não foi possível reiniciar a vila."});
  }
});

app.get("/api/game/backup/latest", auth, async (req,res) => {
  try{
    const {rows}=await pool.query(
      `SELECT game_state,created_at
       FROM game_state_backups
       WHERE user_id=$1
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user.id]
    );
    res.set("Cache-Control","no-store");
    res.json({backup:rows[0]?.game_state||null,createdAt:rows[0]?.created_at||null});
  }catch(e){
    res.status(500).json({error:"Não foi possível carregar o backup."});
  }
});

app.post("/api/game/backup/restore", auth, async (req,res) => {
  try{
    const {rows}=await pool.query(
      `SELECT game_state FROM game_state_backups
       WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    if(!rows.length)return res.status(404).json({error:"Nenhum backup disponível."});
    const state=sanitizeGameState(rows[0].game_state);
    await pool.query(
      "UPDATE users SET game_state=$1::jsonb,last_seen=NOW() WHERE id=$2",
      [JSON.stringify(state),req.user.id]
    );
    res.json({ok:true,state});
  }catch(e){
    res.status(500).json({error:"Não foi possível restaurar o backup."});
  }
});


function fallbackOpponent(requester) {
  const lv=Math.max(1,Number(requester?.game_state?.buildings?.find?.(b=>b.type==="town")?.level||1));
  return {
    source:"fallback",
    userId:null,
    name:"Vila de Treinamento",
    trophies:Math.max(50,lv*80),
    gold:1200+lv*600,
    elixir:1000+lv*550,
    gameState:{
      playerName:"Vila de Treinamento",
      trophies:Math.max(50,lv*80),
      buildings:[
        {id:"ftown",type:"town",x:8,y:5,level:lv},
        {id:"fc1",type:"cannon",x:5,y:4,level:Math.max(1,lv)},
        {id:"ft1",type:"tower",x:11,y:4,level:Math.max(1,lv)},
        {id:"fg1",type:"storage",x:6,y:8,level:Math.max(1,lv)},
        {id:"fe1",type:"elixirstorage",x:10,y:8,level:Math.max(1,lv)},
        {id:"fb1",type:"barracks",x:8,y:9,level:Math.max(1,lv)}
      ]
    }
  };
}

app.get("/api/opponents/search", auth, async (req,res) => {
  try {
    const requesterId=String(req.user.id);

    await pool.query(
      "UPDATE users SET last_seen=NOW() WHERE id=$1",
      [requesterId]
    );

    const selfQ=await pool.query(
      "SELECT id,name,game_state FROM users WHERE id=$1 LIMIT 1",
      [requesterId]
    );
    const self=selfQ.rows[0]||{};

    // Busca SOMENTE outras contas reais com ID e vila salva.
    const {rows}=await pool.query(
      `SELECT id,name,email,gold,elixir,game_state,last_seen
       FROM users
       WHERE id <> $1
         AND game_state IS NOT NULL
         AND jsonb_typeof(game_state)='object'
         AND jsonb_array_length(COALESCE(game_state->'buildings','[]'::jsonb)) > 0
       ORDER BY
         CASE WHEN last_seen > NOW() - INTERVAL '7 days' THEN 0 ELSE 1 END,
         last_seen DESC NULLS LAST,
         RANDOM()
       LIMIT 50`,
      [requesterId]
    );

    // Nenhuma outra conta/vila real: usa a vila manual.
    if(!rows.length){
      const fallback=fallbackOpponent(self);
      return res.json({
        ok:true,
        found:false,
        fallback:true,
        searchedById:true,
        requesterId,
        candidates:0,
        opponent:fallback
      });
    }

    // Escolhe uma das contas reais encontradas.
    const row=rows[Math.floor(Math.random()*rows.length)];
    const gs=row.game_state||{};

    return res.json({
      ok:true,
      found:true,
      fallback:false,
      searchedById:true,
      requesterId,
      candidates:rows.length,
      opponent:{
        source:"real",
        userId:String(row.id),
        name:row.name||gs.playerName||"Jogador",
        trophies:Number(gs.trophies??0),
        gold:Number(row.gold??gs.gold??0),
        elixir:Number(row.elixir??gs.elixir??0),
        gameState:gs,
        lastSeen:row.last_seen
      }
    });
  } catch(e) {
    console.error("opponent search",e);
    res.status(500).json({
      error:"Falha ao buscar oponente real.",
      detail:process.env.NODE_ENV==="development"?String(e.message||e):undefined
    });
  }
});

app.get("/api/health", async (req,res) => {
  try{
    const q=await pool.query("SELECT COUNT(*)::int AS total, COUNT(game_state)::int AS villages FROM users");
    res.set("Cache-Control","no-store");
    res.json({
      online:true,
      service:"Empire Forge API",
      version:"35.10-real-matchmaking-save",
      database:true,
      databaseType:"postgresql",
      users:Number(q.rows[0]?.total||0),
      villages:Number(q.rows[0]?.villages||0),
      matchmaking:"real-id",
      gameStateIncludes:["buildings","army","queue","lab","hero","stats"],
      backups:true
    });
  }catch(e){
    res.status(503).json({online:false,database:false,error:"database_unavailable"});
  }
});


app.get("/api/account/status", auth, async (req,res) => {
  try{
    const q = await pool.query(
      `SELECT id,name,email,gems,gold,elixir,game_state,last_seen,created_at
       FROM users
       WHERE id=$1
       LIMIT 1`,
      [req.user.id]
    );

    const u = q.rows[0];
    if(!u) return res.status(404).json({error:"Conta não encontrada."});

    const gs = u.game_state && typeof u.game_state === "object" ? u.game_state : {};
    const buildings = Array.isArray(gs.buildings) ? gs.buildings : [];
    const army = Array.isArray(gs.army) ? gs.army : [];
    const queue = Array.isArray(gs.queue) ? gs.queue : [];

    const backups = await pool.query(
      `SELECT COUNT(*)::int AS total, MAX(created_at) AS latest
       FROM game_state_backups
       WHERE user_id=$1`,
      [req.user.id]
    );

    const opponents = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM users
       WHERE id<>$1
         AND game_state IS NOT NULL
         AND jsonb_typeof(game_state)='object'
         AND jsonb_array_length(COALESCE(game_state->'buildings','[]'::jsonb)) > 0`,
      [req.user.id]
    );

    res.set("Cache-Control","no-store");
    res.json({
      online:true,
      account:{
        id:u.id,
        name:u.name,
        email:u.email,
        createdAt:u.created_at,
        lastSeen:u.last_seen
      },
      wallet:{
        gems:Number(u.gems||0),
        gold:Number(u.gold||0),
        elixir:Number(u.elixir||0)
      },
      village:{
        saved:buildings.length>0,
        buildings:buildings.length,
        army:army.length,
        queue:queue.length,
        level:Number(gs.level||1),
        trophies:Number(gs.trophies||0),
        updatedAt:gs.updatedAt||null
      },
      backup:{
        total:Number(backups.rows[0]?.total||0),
        latest:backups.rows[0]?.latest||null
      },
      matchmaking:{
        realOpponentsAvailable:Number(opponents.rows[0]?.total||0)
      }
    });
  }catch(e){
    console.error("account status",e);
    res.status(500).json({error:"Não foi possível verificar a conta."});
  }
});

app.get("/api/wallet", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT id,name,email,gems,gold,elixir FROM users WHERE id = $1 LIMIT 1",
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
    gems: Number(u.gems || 0),
    gold: Number(u.gold || 0),
    elixir: Number(u.elixir || 0)
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
    70: { gems: 70, amountCents: 490, price: "R$ 4,90" },
    170: { gems: 170, amountCents: 1590, price: "R$ 15,90" },
    270: { gems: 270, amountCents: 2590, price: "R$ 25,90" },
    370: { gems: 370, amountCents: 3590, price: "R$ 35,90" },
    470: { gems: 470, amountCents: 4590, price: "R$ 45,90" },
    670: { gems: 670, amountCents: 5090, price: "R$ 50,90" }
  });
});


app.post("/api/store/resource-pix", auth, async (req, res) => {
  try {
    const resource = String(req.body.resource || "").toLowerCase();
    const pack = RESOURCE_PACKS[resource];
    if (!pack) return res.status(400).json({error:"Pacote de recurso inválido."});
    if (!PUBLIC_BACKEND_URL) return res.status(500).json({error:"PUBLIC_BACKEND_URL não configurada."});

    const orderId = uid("RESOURCE");
    const payload = {
      transaction_amount: pack.amount_cents / 100,
      description: `Empire Forge - 10.000 ${resource === "gold" ? "Ouro" : "Elixir"}`,
      payment_method_id: "pix",
      payer: { email: req.user.email },
      external_reference: orderId,
      notification_url: PUBLIC_BACKEND_URL + "/api/pix/webhook"
    };

    const payment = await mpFetch("/v1/payments", {
      method:"POST",
      headers:{"X-Idempotency-Key":orderId},
      body:JSON.stringify(payload)
    });

    await pool.query(
      `INSERT INTO pix_orders
       (id,payment_id,user_id,gems,amount_cents,status,order_type,resource_type,resource_amount)
       VALUES($1,$2,$3,0,$4,$5,'resource',$6,$7)`,
      [orderId,String(payment.id),req.user.id,pack.amount_cents,
       String(payment.status||"pending"),pack.resource_type,pack.resource_amount]
    );

    const td=payment.point_of_interaction?.transaction_data||{};
    res.json({
      orderId,
      paymentId:String(payment.id),
      status:payment.status||"pending",
      orderType:"resource",
      resourceType:pack.resource_type,
      resourceAmount:pack.resource_amount,
      qrCode:td.qr_code||"",
      qrBase64:td.qr_code_base64||""
    });
  } catch(e) {
    console.error("resource pix",e);
    res.status(500).json({error:e.message||"Erro ao gerar Pix do recurso."});
  }
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
      "SELECT gems,gold,elixir FROM users WHERE id = $1 LIMIT 1",
      [req.user.id]
    );

    const user = userResult.rows[0];

    res.json({
      status: order.status,
      orderType: order.order_type || "gems",
      gems: Number(order.gems || 0),
      resourceType: order.resource_type || null,
      resourceAmount: Number(order.resource_amount || 0),
      balance: Number(user?.gems || 0),
      gold: Number(user?.gold || 0),
      elixir: Number(user?.elixir || 0),
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
      console.log("Empire Forge API V35.10 online na porta", PORT);
    });

  } catch (e) {
    console.error("Falha ao iniciar banco PostgreSQL:", e);
    process.exit(1);
  }
}

start();
