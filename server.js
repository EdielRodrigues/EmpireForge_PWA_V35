
require("dotenv").config();
const express=require("express");
const cors=require("cors");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const Database=require("better-sqlite3");
const crypto=require("crypto");

const app=express();
const PORT=Number(process.env.PORT||3000);
const JWT_SECRET=process.env.JWT_SECRET||"CHANGE_ME";
const ACCESS_TOKEN=process.env.MERCADOPAGO_ACCESS_TOKEN||"";
const PUBLIC_BACKEND_URL=(process.env.PUBLIC_BACKEND_URL||"").replace(/\/+$/,"");
const DB_FILE=process.env.DB_FILE||"./empireforge.db";

app.use(cors({origin:process.env.FRONTEND_ORIGIN?process.env.FRONTEND_ORIGIN.split(","):true,credentials:false}));
app.use(express.json({limit:"1mb"}));

const db=new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  gems INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pix_orders(
  id TEXT PRIMARY KEY,
  payment_id TEXT UNIQUE,
  user_id TEXT NOT NULL,
  gems INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  credited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

const PACKS={
  500:799,
  1000:1699,
  1500:3399,
  2000:6699
};

function userPublic(u){return {id:u.id,name:u.name,email:u.email,phone:u.phone,gems:Number(u.gems||0)}}
function sign(user){return jwt.sign({sub:user.id,email:user.email},JWT_SECRET,{expiresIn:"30d"})}
function auth(req,res,next){
  try{
    const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
    const p=jwt.verify(token,JWT_SECRET);
    const u=db.prepare("SELECT * FROM users WHERE id=?").get(p.sub);
    if(!u)return res.status(401).json({error:"Sessão inválida."});
    req.user=u;next();
  }catch(_){return res.status(401).json({error:"Faça login novamente."})}
}
function uid(prefix){return prefix+"_"+crypto.randomUUID()}

app.get("/health",(req,res)=>res.json({online:true,service:"Empire Forge API",pixConfigured:!!ACCESS_TOKEN}));

app.post("/api/auth/register",async(req,res)=>{
  try{
    const name=String(req.body.name||"").trim().slice(0,30);
    const email=String(req.body.email||"").trim().toLowerCase();
    const phone=String(req.body.phone||"").replace(/\D/g,"");
    const password=String(req.body.password||"");
    if(name.length<2||!email.includes("@")||phone.length<10||password.length<6)
      return res.status(400).json({error:"Dados de cadastro inválidos."});
    if(db.prepare("SELECT id FROM users WHERE email=?").get(email))
      return res.status(409).json({error:"E-mail já cadastrado."});
    const id=uid("EF");
    const hash=await bcrypt.hash(password,12);
    db.prepare("INSERT INTO users(id,name,email,phone,password_hash) VALUES(?,?,?,?,?)").run(id,name,email,phone,hash);
    const u=db.prepare("SELECT * FROM users WHERE id=?").get(id);
    res.json({token:sign(u),user:userPublic(u)});
  }catch(e){console.error(e);res.status(500).json({error:"Erro ao cadastrar."})}
});

app.post("/api/auth/login",async(req,res)=>{
  try{
    const email=String(req.body.email||"").trim().toLowerCase();
    const password=String(req.body.password||"");
    const u=db.prepare("SELECT * FROM users WHERE email=?").get(email);
    if(!u||!(await bcrypt.compare(password,u.password_hash)))
      return res.status(401).json({error:"E-mail ou senha incorretos."});
    res.json({token:sign(u),user:userPublic(u)});
  }catch(e){console.error(e);res.status(500).json({error:"Erro ao entrar."})}
});

app.get("/api/auth/me",auth,(req,res)=>{
  const u=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  res.json({user:userPublic(u)});
});

async function mpFetch(path,options={}){
  if(!ACCESS_TOKEN)throw new Error("MERCADOPAGO_ACCESS_TOKEN não configurado.");
  const r=await fetch("https://api.mercadopago.com"+path,{
    ...options,
    headers:{
      "Authorization":"Bearer "+ACCESS_TOKEN,
      "Content-Type":"application/json",
      ...(options.headers||{})
    }
  });
  const data=await r.json();
  if(!r.ok)throw new Error(data.message||data.error||"Erro Mercado Pago");
  return data;
}

app.post("/api/pix/create",auth,async(req,res)=>{
  try{
    const gems=Number(req.body.gems);
    const cents=PACKS[gems];
    if(!cents)return res.status(400).json({error:"Pacote inválido."});
    if(!PUBLIC_BACKEND_URL)return res.status(500).json({error:"PUBLIC_BACKEND_URL não configurada."});

    const orderId=uid("ORDER");
    const payload={
      transaction_amount:cents/100,
      description:`Empire Forge - ${gems} gemas`,
      payment_method_id:"pix",
      payer:{email:req.user.email},
      external_reference:orderId,
      notification_url:PUBLIC_BACKEND_URL+"/api/pix/webhook"
    };
    const payment=await mpFetch("/v1/payments",{
      method:"POST",
      headers:{"X-Idempotency-Key":orderId},
      body:JSON.stringify(payload)
    });

    db.prepare(`INSERT INTO pix_orders(id,payment_id,user_id,gems,amount_cents,status)
                VALUES(?,?,?,?,?,?)`)
      .run(orderId,String(payment.id),req.user.id,gems,cents,String(payment.status||"pending"));

    const td=payment.point_of_interaction?.transaction_data||{};
    res.json({
      orderId,
      paymentId:String(payment.id),
      status:payment.status||"pending",
      qrCode:td.qr_code||"",
      qrBase64:td.qr_code_base64||""
    });
  }catch(e){console.error(e);res.status(500).json({error:e.message||"Erro ao gerar Pix."})}
});

function creditApprovedPayment(payment){
  const orderId=String(payment.external_reference||"");
  if(!orderId||String(payment.status)!=="approved")return false;

  const tx=db.transaction(()=>{
    const ord=db.prepare("SELECT * FROM pix_orders WHERE id=?").get(orderId);
    if(!ord)return false;
    if(ord.credited)return true;
    if(String(ord.payment_id)!==String(payment.id))return false;

    db.prepare("UPDATE pix_orders SET status='approved',credited=1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(orderId);
    db.prepare("UPDATE users SET gems=gems+? WHERE id=?").run(ord.gems,ord.user_id);
    return true;
  });
  return tx();
}

app.post("/api/pix/webhook",async(req,res)=>{
  // Responda rápido ao provedor; a validação/consulta do pagamento usa a API oficial.
  res.sendStatus(200);
  try{
    const paymentId=String(req.body?.data?.id||req.query?.["data.id"]||req.query?.id||"");
    if(!paymentId)return;
    const payment=await mpFetch("/v1/payments/"+encodeURIComponent(paymentId),{method:"GET"});
    const ord=db.prepare("SELECT * FROM pix_orders WHERE payment_id=?").get(String(payment.id));
    if(ord){
      db.prepare("UPDATE pix_orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE payment_id=?")
        .run(String(payment.status||"pending"),String(payment.id));
    }
    creditApprovedPayment(payment);
  }catch(e){console.error("webhook",e)}
});

app.get("/api/pix/status/:paymentId",auth,async(req,res)=>{
  try{
    const id=String(req.params.paymentId);
    let ord=db.prepare("SELECT * FROM pix_orders WHERE payment_id=? AND user_id=?").get(id,req.user.id);
    if(!ord)return res.status(404).json({error:"Pagamento não encontrado."});

    // Consulta a fonte oficial também, útil caso o webhook demore.
    if(ACCESS_TOKEN && ord.status!=="approved"){
      try{
        const payment=await mpFetch("/v1/payments/"+encodeURIComponent(id),{method:"GET"});
        db.prepare("UPDATE pix_orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE payment_id=?")
          .run(String(payment.status||"pending"),id);
        creditApprovedPayment(payment);
      }catch(_){}
    }
    ord=db.prepare("SELECT * FROM pix_orders WHERE payment_id=? AND user_id=?").get(id,req.user.id);
    const u=db.prepare("SELECT gems FROM users WHERE id=?").get(req.user.id);
    res.json({status:ord.status,gems:ord.gems,balance:Number(u.gems||0),credited:!!ord.credited});
  }catch(e){console.error(e);res.status(500).json({error:"Erro ao consultar pagamento."})}
});

app.listen(PORT,()=>console.log("Empire Forge API online na porta",PORT));
