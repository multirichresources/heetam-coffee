// Server Heetam Coffee (Cloudflare Worker).
// Fail statik (page, gambar) diservis terus oleh Cloudflare; laluan /api/* masuk ke sini.
//
// Secrets yang diperlukan (Settings → Variables and secrets):
//   CHIP_BRAND_ID, CHIP_SECRET_KEY, ADMIN_PASSWORD
//   SPX_USER_ID, SPX_SECRET_KEY (untuk integrasi SPX kemudian)

const CHIP_API = "https://gate.chip-in.asia/api/v1";

// Harga dalam sen. Sumber kebenaran harga ialah di sini, bukan di browser.
const CATALOG = {
  "ethiopia-bombe":     { name: "Ethiopia Bombe",     price: { "500g": 6500, "1kg": 9500 } },
  "royal-indo":         { name: "Royal Indo",         price: { "500g": 5490, "1kg": 8500 } },
  "brazil-parana":      { name: "Brazil Parana",      price: { "500g": 5990, "1kg": 8500 } },
  "king-gayo":          { name: "King Gayo",          price: { "500g": 6500, "1kg": 9500 } },
  "brazil-el-salvador": { name: "Brazil El-Salvador", price: { "500g": 5490, "1kg": 8500 } },
  "cartel-papua":       { name: "Cartel Papua",       price: { "500g": 6500, "1kg": 8900 } },
  "italian-mafia":      { name: "Italian Mafia",      price: { "500g": 5490, "1kg": 8500 } },
  "test-order":         { name: "Test Order",         price: { "test": 100 }, test: true }
};
const KG = { "500g": 0.5, "1kg": 1, "test": 0 };
const GRINDS = { whole: "Whole Bean", fine: "Halus" };
const STATES = ["Johor","Kedah","Kelantan","Melaka","Negeri Sembilan","Pahang","Perak","Perlis","Pulau Pinang","Sabah","Sarawak","Selangor","Terengganu","W.P. Kuala Lumpur","W.P. Labuan","W.P. Putrajaya"];

function postageSen(kg) {
  if (kg <= 0) return 0;
  if (kg <= 3) return 1000;
  return 1000 + Math.ceil((kg - 3) / 3) * 1000;
}

const json = (data, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const now = () => new Date().toISOString();
const clean = (v, max = 200) => String(v == null ? "" : v).trim().slice(0, max);
function normPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("60")) d = "0" + d.slice(2);
  return d;
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}
function orderId() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // waktu Malaysia
  const ymd = String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
  const n = new Uint32Array(1); crypto.getRandomValues(n);
  return "HTM-" + ymd + "-" + String(1000 + (n[0] % 9000));
}
function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function chip(env, path, init = {}) {
  const res = await fetch(CHIP_API + path, {
    ...init,
    headers: { "Authorization": "Bearer " + env.CHIP_SECRET_KEY, "Content-Type": "application/json", ...(init.headers || {}) }
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

// Semak status bayaran terus dengan CHIP (tidak percaya data callback bulat-bulat).
async function syncPayment(env, order) {
  if (!order || order.status !== "pending" || !order.chip_id) return order;
  const r = await chip(env, "/purchases/" + encodeURIComponent(order.chip_id) + "/");
  if (!r.ok) return order;
  const st = r.body.status;
  if (st === "paid") {
    const paidAt = now();
    const upd = await env.DB.prepare("UPDATE orders SET status='paid', paid_at=? WHERE id=? AND status='pending'").bind(paidAt, order.id).run();
    if (upd.meta && upd.meta.changes > 0) {
      await env.DB.prepare("UPDATE customers SET order_count = order_count + 1, updated_at=? WHERE phone=?").bind(paidAt, order.phone).run();
    }
    return { ...order, status: "paid", paid_at: paidAt };
  }
  if (["error", "cancelled", "expired", "blocked"].includes(st)) {
    await env.DB.prepare("UPDATE orders SET status='failed' WHERE id=? AND status='pending'").bind(order.id).run();
    return { ...order, status: "failed" };
  }
  return order;
}

async function handleCheckout(request, env) {
  if (!env.CHIP_BRAND_ID || !env.CHIP_SECRET_KEY) return json({ ok: false, error: "Bayaran belum dikonfigurasi." }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "Data tidak sah." }, 400); }
  const c = b.customer || {};
  const cust = {
    phone: normPhone(c.phone), name: clean(c.name, 100), email: clean(c.email, 120).toLowerCase(),
    addr1: clean(c.addr1), addr2: clean(c.addr2), postcode: clean(c.postcode, 5), city: clean(c.city, 80), state: clean(c.state, 40)
  };
  const errs = [];
  if (!/^01\d{8,9}$/.test(cust.phone)) errs.push("No. telefon");
  if (cust.name.length < 3) errs.push("Nama");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cust.email)) errs.push("Emel");
  if (cust.addr1.length < 5) errs.push("Alamat");
  if (!/^\d{5}$/.test(cust.postcode)) errs.push("Poskod");
  if (cust.city.length < 2) errs.push("Bandar");
  if (!STATES.includes(cust.state)) errs.push("Negeri");
  if (errs.length) return json({ ok: false, error: "Sila semak: " + errs.join(", ") + "." }, 400);

  const raw = Array.isArray(b.items) ? b.items.slice(0, 30) : [];
  const items = [];
  let subtotal = 0, kg = 0, allTest = true;
  for (const it of raw) {
    const p = CATALOG[it && it.id];
    if (!p) continue;
    const size = String(it.size);
    const unit = p.price[size];
    const qty = Math.max(1, Math.min(50, parseInt(it.qty, 10) || 0));
    if (!unit) continue;
    const grind = p.test ? "-" : (GRINDS[it.grind] ? it.grind : "whole");
    if (!p.test) allTest = false;
    items.push({ id: it.id, name: p.name, size, grind, grind_label: p.test ? "-" : GRINDS[grind], qty, unit, line: unit * qty });
    subtotal += unit * qty;
    kg += (KG[size] || 0) * qty;
  }
  if (!items.length) return json({ ok: false, error: "Cart kosong." }, 400);
  const postage = allTest ? 0 : postageSen(kg);
  const total = subtotal + postage;

  let id = orderId();
  for (let i = 0; i < 4; i++) {
    const ex = await env.DB.prepare("SELECT 1 FROM orders WHERE id=?").bind(id).first();
    if (!ex) break;
    id = orderId();
  }
  const token = randomHex(16);
  const created = now();
  const note = clean(b.note, 500);
  const consent = b.consent ? 1 : 0;

  await env.DB.prepare(
    "INSERT INTO orders (id, phone, name, email, addr1, addr2, postcode, city, state, note, items, subtotal, postage, total, status, is_test, created_at, token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, ?)"
  ).bind(id, cust.phone, cust.name, cust.email, cust.addr1, cust.addr2, cust.postcode, cust.city, cust.state, note, JSON.stringify(items), subtotal, postage, total, allTest ? 1 : 0, created, token).run();

  await env.DB.prepare(
    "INSERT INTO customers (phone, name, email, addr1, addr2, postcode, city, state, consent, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(phone) DO UPDATE SET name=excluded.name, email=excluded.email, addr1=excluded.addr1, addr2=excluded.addr2, postcode=excluded.postcode, city=excluded.city, state=excluded.state, consent=excluded.consent, updated_at=excluded.updated_at"
  ).bind(cust.phone, cust.name, cust.email, cust.addr1, cust.addr2, cust.postcode, cust.city, cust.state, consent, created, created).run();

  const origin = new URL(request.url).origin;
  const back = origin + "/?order=" + encodeURIComponent(id) + "&t=" + token;
  const products = items.map(it => ({
    name: it.name + (it.id === "test-order" ? "" : " " + it.size + " (" + it.grind_label + ")"),
    price: it.unit,
    quantity: it.qty
  }));
  if (postage > 0) products.push({ name: "Pos (" + (Math.round(kg * 10) / 10) + "kg)", price: postage, quantity: 1 });

  const r = await chip(env, "/purchases/", {
    method: "POST",
    body: JSON.stringify({
      brand_id: env.CHIP_BRAND_ID,
      reference: id,
      send_receipt: true,
      client: {
        email: cust.email, full_name: cust.name, phone: cust.phone,
        street_address: [cust.addr1, cust.addr2].filter(Boolean).join(", "),
        city: cust.city, zip_code: cust.postcode, state: cust.state, country: "MY"
      },
      purchase: { currency: "MYR", products, notes: note || undefined },
      success_redirect: back + "&s=ok",
      failure_redirect: back + "&s=fail",
      cancel_redirect: back + "&s=cancel",
      success_callback: origin + "/api/chip/callback"
    })
  });
  if (!r.ok || !r.body.checkout_url) {
    await env.DB.prepare("UPDATE orders SET status='failed' WHERE id=?").bind(id).run();
    console.log("CHIP create failed", r.status, JSON.stringify(r.body).slice(0, 500));
    return json({ ok: false, error: "Tidak dapat sambung ke CHIP. Sila cuba sebentar lagi." }, 502);
  }
  await env.DB.prepare("UPDATE orders SET chip_id=? WHERE id=?").bind(r.body.id, id).run();
  return json({ ok: true, order: id, checkout_url: r.body.checkout_url });
}

async function handleCallback(request, env) {
  let b = {};
  try { b = await request.json(); } catch {}
  const chipId = b && b.id;
  if (!chipId) return json({ ok: false }, 400);
  const order = await env.DB.prepare("SELECT * FROM orders WHERE chip_id=?").bind(String(chipId)).first();
  if (order) await syncPayment(env, order);
  return json({ ok: true });
}

async function handleOrderStatus(url, env) {
  const id = url.searchParams.get("id") || "";
  const t = url.searchParams.get("t") || "";
  let order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
  if (!order || !safeEqual(order.token, t)) return json({ ok: false, error: "Order tidak dijumpai." }, 404);
  order = await syncPayment(env, order);
  return json({
    ok: true,
    order: {
      id: order.id, status: order.status, name: order.name, email: order.email, phone: order.phone,
      addr1: order.addr1, addr2: order.addr2, postcode: order.postcode, city: order.city, state: order.state,
      items: JSON.parse(order.items), subtotal: order.subtotal, postage: order.postage, total: order.total
    }
  });
}

// ---------- Admin ----------
function isAdmin(request, env) {
  const h = request.headers.get("authorization") || "";
  return env.ADMIN_PASSWORD && safeEqual(h.replace(/^Bearer\s+/i, ""), env.ADMIN_PASSWORD);
}
async function handleAdmin(request, url, env) {
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: "ADMIN_PASSWORD belum ditetapkan dalam Cloudflare." }, 503);
  if (!isAdmin(request, env)) return json({ ok: false, error: "Kata laluan salah." }, 401);
  const path = url.pathname;

  if (path === "/api/admin/orders" && request.method === "GET") {
    const status = url.searchParams.get("status") || "paid";
    const allowed = ["pending", "paid", "shipped", "failed", "all"];
    const st = allowed.includes(status) ? status : "paid";
    const q = st === "all"
      ? env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500")
      : env.DB.prepare("SELECT * FROM orders WHERE status=? ORDER BY created_at DESC LIMIT 500").bind(st);
    const { results } = await q.all();
    const counts = {};
    const c = await env.DB.prepare("SELECT status, COUNT(*) n FROM orders GROUP BY status").all();
    for (const r of c.results) counts[r.status] = r.n;
    return json({ ok: true, orders: results.map(o => ({ ...o, items: JSON.parse(o.items), token: undefined })), counts });
  }

  if (path === "/api/admin/ship" && request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const id = clean(b.id, 40), tracking = clean(b.tracking, 60);
    const r = await env.DB.prepare("UPDATE orders SET status='shipped', tracking=?, shipped_at=? WHERE id=? AND status IN ('paid','shipped')").bind(tracking, now(), id).run();
    return json({ ok: r.meta.changes > 0 });
  }

  if (path === "/api/admin/refresh" && request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(clean(b.id, 40)).first();
    const o = await syncPayment(env, order);
    return json({ ok: Boolean(o), status: o && o.status });
  }

  if (path === "/api/admin/customers" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT phone, name, email, city, state, consent, order_count, created_at, updated_at FROM customers ORDER BY updated_at DESC LIMIT 2000").all();
    return json({ ok: true, customers: results });
  }

  return json({ ok: false, error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/api/health") {
        return json({
          ok: true,
          db: Boolean(env.DB),
          chip_brand_id: Boolean(env.CHIP_BRAND_ID),
          chip_secret_key: Boolean(env.CHIP_SECRET_KEY),
          admin_password: Boolean(env.ADMIN_PASSWORD),
          spx_user_id: Boolean(env.SPX_USER_ID),
          spx_secret_key: Boolean(env.SPX_SECRET_KEY)
        });
      }
      if (p === "/api/checkout" && request.method === "POST") return await handleCheckout(request, env);
      if (p === "/api/chip/callback" && request.method === "POST") return await handleCallback(request, env);
      if (p === "/api/order" && request.method === "GET") return await handleOrderStatus(url, env);
      if (p.startsWith("/api/admin/")) return await handleAdmin(request, url, env);
      if (p.startsWith("/api/")) return json({ ok: false, error: "Not found" }, 404);
    } catch (e) {
      console.log("API error", p, e && e.stack || e);
      return json({ ok: false, error: "Ralat server. Sila cuba lagi." }, 500);
    }
    return env.ASSETS.fetch(request);
  }
};
