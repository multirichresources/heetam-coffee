// Server Heetam Coffee (Cloudflare Worker).
// Fail statik (page, gambar) diservis terus oleh Cloudflare; laluan /api/* masuk ke sini.
//
// Secrets yang diperlukan (Settings → Variables and secrets):
//   CHIP_BRAND_ID, CHIP_SECRET_KEY, ADMIN_PASSWORD
//   SPX_USER_ID, SPX_SECRET_KEY (untuk integrasi SPX kemudian)

import * as EP from "./easyparcel.js";

const CHIP_API = "https://gate.chip-in.asia/api/v1";

// Harga dalam sen. Sumber kebenaran harga ialah di sini, bukan di browser.
// Produk sebenar disimpan dalam jadual "products" (D1). Harga dalam sen.
const TEST_ITEM = { name: "Test Order", price: { "test": 100 }, test: true };
async function loadCatalog(env) {
  const { results } = await env.DB.prepare("SELECT id, name, price500, price1kg FROM products WHERE visible=1").all();
  const cat = { "test-order": TEST_ITEM };
  for (const r of results) cat[r.id] = { name: r.name, price: { "500g": r.price500, "1kg": r.price1kg } };
  return cat;
}
const PRODUCT_FIELDS = ["name","cat","tag","badge","origin","bean","aroma","notes","body","acid","after","roast","image"];
function slugify(t) {
  return String(t || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "produk";
}
function publicProduct(r) {
  return { id: r.id, name: r.name, cat: r.cat, tag: r.tag, badge: r.badge, strong: Boolean(r.strong), origin: r.origin, bean: r.bean,
    aroma: r.aroma, notes: r.notes, body: r.body, acid: r.acid, after: r.after, roast: r.roast, image: r.image,
    price: { "500g": r.price500 / 100, "1kg": r.price1kg / 100 } };
}
async function deleteMedia(env, url) {
  if (env.IMAGES && typeof url === "string" && url.startsWith("/media/")) {
    try { await env.IMAGES.delete(url.slice(7)); } catch {}
  }
}
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
  const CATALOG = await loadCatalog(env);
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
    return json({ ok: false, error: "Tidak dapat sambung ke halaman bayaran. Sila cuba sebentar lagi." }, 502);
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
    const my = new Date(Date.now() + 8 * 3600 * 1000);
    const monthStart = new Date(Date.UTC(my.getUTCFullYear(), my.getUTCMonth(), 1) - 8 * 3600 * 1000).toISOString();
    const dayStart = new Date(Date.UTC(my.getUTCFullYear(), my.getUTCMonth(), my.getUTCDate()) - 8 * 3600 * 1000).toISOString();
    const sum = await env.DB.prepare(
      "SELECT COALESCE(SUM(CASE WHEN paid_at >= ? THEN total END),0) month_total, COUNT(CASE WHEN paid_at >= ? THEN 1 END) month_orders, " +
      "COALESCE(SUM(CASE WHEN paid_at >= ? THEN total END),0) day_total FROM orders WHERE status IN ('paid','shipped') AND is_test=0"
    ).bind(monthStart, monthStart, dayStart).first();
    return json({ ok: true, orders: results.map(o => ({ ...o, items: JSON.parse(o.items), token: undefined })), counts, summary: sum });
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

  // ----- Produk -----
  if (path === "/api/admin/products" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM products ORDER BY sort, name").all();
    return json({ ok: true, products: results });
  }
  if (path === "/api/admin/products" && request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const v = {};
    for (const f of PRODUCT_FIELDS) v[f] = clean(b[f], f === "image" ? 300 : 200);
    v.name = clean(b.name, 80);
    const p500 = Math.round(parseFloat(b.price500) * 100), p1k = Math.round(parseFloat(b.price1kg) * 100);
    if (v.name.length < 2) return json({ ok: false, error: "Nama produk wajib diisi." }, 400);
    if (!(p500 > 0) || !(p1k > 0) || p500 > 1000000 || p1k > 1000000) return json({ ok: false, error: "Harga 500g dan 1kg wajib diisi dengan betul." }, 400);
    if (v.image && !/^\/(media|img)\//.test(v.image)) return json({ ok: false, error: "Gambar tidak sah." }, 400);
    const visible = b.visible ? 1 : 0, strong = b.strong ? 1 : 0;
    const sort = Math.max(0, Math.min(9999, parseInt(b.sort, 10) || 100));
    let id = clean(b.id, 60);
    const existing = id ? await env.DB.prepare("SELECT image FROM products WHERE id=?").bind(id).first() : null;
    if (!existing) {
      const base = slugify(v.name); id = base;
      for (let i = 2; await env.DB.prepare("SELECT 1 FROM products WHERE id=?").bind(id).first(); i++) id = base + "-" + i;
      await env.DB.prepare("INSERT INTO products (id,name,cat,tag,badge,strong,origin,bean,aroma,notes,body,acid,after,roast,price500,price1kg,image,visible,sort,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, v.name, v.cat, v.tag, v.badge, strong, v.origin, v.bean, v.aroma, v.notes, v.body, v.acid, v.after, v.roast, p500, p1k, v.image, visible, sort, now()).run();
    } else {
      await env.DB.prepare("UPDATE products SET name=?,cat=?,tag=?,badge=?,strong=?,origin=?,bean=?,aroma=?,notes=?,body=?,acid=?,after=?,roast=?,price500=?,price1kg=?,image=?,visible=?,sort=?,updated_at=? WHERE id=?")
        .bind(v.name, v.cat, v.tag, v.badge, strong, v.origin, v.bean, v.aroma, v.notes, v.body, v.acid, v.after, v.roast, p500, p1k, v.image, visible, sort, now(), id).run();
      if (existing.image && existing.image !== v.image) await deleteMedia(env, existing.image);
    }
    return json({ ok: true, id });
  }
  if (path === "/api/admin/products/delete" && request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const row = await env.DB.prepare("SELECT image FROM products WHERE id=?").bind(clean(b.id, 60)).first();
    if (!row) return json({ ok: false, error: "Produk tidak dijumpai." }, 404);
    await env.DB.prepare("DELETE FROM products WHERE id=?").bind(clean(b.id, 60)).run();
    await deleteMedia(env, row.image);
    return json({ ok: true });
  }

  // ----- Testimoni -----
  if (path === "/api/admin/testimonials" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM testimonials ORDER BY sort, id DESC").all();
    return json({ ok: true, testimonials: results });
  }
  if (path === "/api/admin/testimonials" && request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const name = clean(b.name, 60), location = clean(b.location, 60), text = clean(b.text, 800), image = clean(b.image, 300);
    if (name.length < 2) return json({ ok: false, error: "Nama pelanggan wajib diisi." }, 400);
    if (text.length < 5 && !image) return json({ ok: false, error: "Isi ayat testimoni atau upload gambar." }, 400);
    if (image && !/^\/(media|img)\//.test(image)) return json({ ok: false, error: "Gambar tidak sah." }, 400);
    const visible = b.visible ? 1 : 0, sort = Math.max(0, Math.min(9999, parseInt(b.sort, 10) || 100));
    const id = parseInt(b.id, 10);
    const existing = id ? await env.DB.prepare("SELECT image FROM testimonials WHERE id=?").bind(id).first() : null;
    if (existing) {
      await env.DB.prepare("UPDATE testimonials SET name=?,location=?,text=?,image=?,visible=?,sort=? WHERE id=?").bind(name, location, text, image, visible, sort, id).run();
      if (existing.image && existing.image !== image) await deleteMedia(env, existing.image);
      return json({ ok: true, id });
    }
    const r = await env.DB.prepare("INSERT INTO testimonials (name,location,text,image,visible,sort,created_at) VALUES (?,?,?,?,?,?,?)").bind(name, location, text, image, visible, sort, now()).run();
    return json({ ok: true, id: r.meta && r.meta.last_row_id });
  }
  if (path === "/api/admin/testimonials/delete" && request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const id = parseInt(b.id, 10);
    const row = await env.DB.prepare("SELECT image FROM testimonials WHERE id=?").bind(id).first();
    if (!row) return json({ ok: false, error: "Testimoni tidak dijumpai." }, 404);
    await env.DB.prepare("DELETE FROM testimonials WHERE id=?").bind(id).run();
    await deleteMedia(env, row.image);
    return json({ ok: true });
  }

  // ----- EasyParcel -----
  if (path.startsWith("/api/admin/easyparcel")) {
    const origin = url.origin;
    let b = {};
    if (request.method === "POST") { try { b = await request.json(); } catch {} }
    if (path === "/api/admin/easyparcel" && request.method === "GET") return json({ ok: true, ...(await EP.status(env, origin)) });
    if (path === "/api/admin/easyparcel/settings" && request.method === "POST") return json({ ok: true, settings: await EP.saveShipSettings(env, b) });
    if (!EP.epConfigured(env)) return json({ ok: false, error: "EASYPARCEL_CLIENT_ID / EASYPARCEL_CLIENT_SECRET belum ditetapkan dalam Cloudflare." }, 503);
    if (path === "/api/admin/easyparcel/connect" && request.method === "POST") return json({ ok: true, url: await EP.startConnect(env, origin) });
    if (path === "/api/admin/easyparcel/disconnect" && request.method === "POST") { await EP.disconnect(env); return json({ ok: true }); }
    const order = b.id ? await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(clean(b.id, 40)).first() : null;
    if (!order) return json({ ok: false, error: "Order tidak dijumpai." }, 404);
    try {
      if (path === "/api/admin/easyparcel/quote" && request.method === "POST") {
        if (order.status !== "paid") return json({ ok: false, error: "Hanya order Dibayar boleh dibooking." }, 400);
        return json({ ok: true, quote: await EP.quote(env, origin, order) });
      }
      if (path === "/api/admin/easyparcel/book" && request.method === "POST") {
        const serviceId = clean(b.service_id, 20);
        if (!serviceId) return json({ ok: false, error: "Pilih kurier dulu." }, 400);
        const claim = await env.DB.prepare("UPDATE orders SET ship_number='BOOKING' WHERE id=? AND status='paid' AND (ship_number IS NULL OR ship_number='')").bind(order.id).run();
        if (!claim.meta || !claim.meta.changes) return json({ ok: false, error: "Order ini sudah dibooking atau bukan status Dibayar." }, 409);
        let r;
        try { r = await EP.book(env, origin, order, serviceId); }
        catch (e) {
          await env.DB.prepare("UPDATE orders SET ship_number=NULL WHERE id=? AND ship_number='BOOKING'").bind(order.id).run();
          throw e;
        }
        await env.DB.prepare("UPDATE orders SET status='shipped', shipped_at=?, ship_number=?, ship_courier=?, ship_cost=?, awb_url=?, tracking=? WHERE id=?")
          .bind(now(), r.ship_number, r.courier, r.cost_sen, r.awb_url || r.tracking_url, r.awb_number || r.ship_number, order.id).run();
        return json({ ok: true, booking: r });
      }
      if (path === "/api/admin/easyparcel/refresh" && request.method === "POST") {
        if (!order.ship_number || order.ship_number === "BOOKING") return json({ ok: false, error: "Order ini belum dibooking melalui EasyParcel." }, 400);
        const d = await EP.details(env, origin, order.ship_number);
        await env.DB.prepare("UPDATE orders SET tracking=COALESCE(?, tracking), awb_url=COALESCE(?, ?, awb_url) WHERE id=?")
          .bind(d.awb_number, d.awb_url, d.tracking_url, order.id).run();
        return json({ ok: true, details: d });
      }
    } catch (e) {
      console.log("EasyParcel error", path, e && e.message);
      return json({ ok: false, error: String(e && e.message || e).slice(0, 400) }, 502);
    }
    return json({ ok: false, error: "Not found" }, 404);
  }

  // ----- Upload gambar -----
  if (path === "/api/admin/upload" && request.method === "POST") {
    if (!env.IMAGES) return json({ ok: false, error: "Storan gambar belum disambung." }, 503);
    const type = (request.headers.get("x-content-type") || "").toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp"].includes(type)) return json({ ok: false, error: "Format gambar mesti JPG, PNG atau WEBP." }, 400);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return json({ ok: false, error: "Gambar kosong." }, 400);
    if (buf.byteLength > 2 * 1024 * 1024) return json({ ok: false, error: "Gambar terlalu besar (maksimum 2MB)." }, 400);
    const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
    const key = "u/" + Date.now().toString(36) + "-" + randomHex(6) + "." + ext;
    await env.IMAGES.put(key, buf, { metadata: { type } });
    return json({ ok: true, url: "/media/" + key });
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
          easyparcel_client: Boolean(env.EASYPARCEL_CLIENT_ID && env.EASYPARCEL_CLIENT_SECRET),
          spx_user_id: Boolean(env.SPX_USER_ID),
          spx_secret_key: Boolean(env.SPX_SECRET_KEY)
        });
      }
      if (p === EP.EP_REDIRECT_PATH && request.method === "GET") {
        try { await EP.handleCallback(env, url); return Response.redirect(url.origin + "/admin?ep=ok", 302); }
        catch (e) { return Response.redirect(url.origin + "/admin?ep=error&msg=" + encodeURIComponent(String(e.message || e).slice(0, 200)), 302); }
      }
      if (p === "/api/products" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM products WHERE visible=1 ORDER BY sort, name").all();
        return json({ ok: true, products: results.map(publicProduct) });
      }
      if (p === "/api/testimonials" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT id, name, location, text, image FROM testimonials WHERE visible=1 ORDER BY sort, id DESC LIMIT 30").all();
        return json({ ok: true, testimonials: results });
      }
      if (p.startsWith("/media/") && request.method === "GET") {
        if (!env.IMAGES) return new Response("Not found", { status: 404 });
        const key = decodeURIComponent(p.slice(7));
        if (!/^u\/[a-z0-9-]+\.(jpg|png|webp)$/.test(key)) return new Response("Not found", { status: 404 });
        const { value, metadata } = await env.IMAGES.getWithMetadata(key, { type: "arrayBuffer" });
        if (!value) return new Response("Not found", { status: 404 });
        return new Response(value, { headers: { "content-type": (metadata && metadata.type) || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
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
