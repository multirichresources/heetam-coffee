// Sambungan EasyParcel Open API (versi 2026-09).
// Dokumen: https://github.com/easyparcel/OpenAPI
// Secrets: EASYPARCEL_CLIENT_ID, EASYPARCEL_CLIENT_SECRET
// Token & tetapan disimpan dalam jadual "settings" (D1).

const EP_BASE = "https://api.easyparcel.com";
const EP_API = EP_BASE + "/open_api/2026-09";
export const EP_REDIRECT_PATH = "/api/easyparcel/callback";

const SUBDIVISION = {
  "Johor": "MY-01", "Kedah": "MY-02", "Kelantan": "MY-03", "Melaka": "MY-04", "Negeri Sembilan": "MY-05",
  "Pahang": "MY-06", "Pulau Pinang": "MY-07", "Perak": "MY-08", "Perlis": "MY-09", "Selangor": "MY-10",
  "Terengganu": "MY-11", "Sabah": "MY-12", "Sarawak": "MY-13", "W.P. Kuala Lumpur": "MY-14",
  "W.P. Labuan": "MY-15", "W.P. Putrajaya": "MY-16"
};
const EAST = ["Sabah", "Sarawak", "W.P. Labuan"];

export const DEFAULT_SHIP_SETTINGS = {
  w500: 0.6, w1kg: 1.1, length: 25, width: 18, height: 10,
  sender_name: "HEETAMCOFF ROASTERY EMPIRE",
  sender_phone: "0139226788",
  sender_email: "heetamcoff.roastery@gmail.com",
  sender_addr1: "Lot Cafe A, MARA Halal Industrial Park",
  sender_addr2: "Jalan Batu Caves",
  sender_postcode: "68100",
  sender_city: "Batu Caves",
  sender_state: "Selangor",
  preferred: "SPX"
};

const nowIso = () => new Date().toISOString();

async function getSetting(env, key) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return null; }
}
async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(key, JSON.stringify(value), nowIso()).run();
}
async function delSetting(env, key) { await env.DB.prepare("DELETE FROM settings WHERE key=?").bind(key).run(); }

export async function getShipSettings(env) {
  return { ...DEFAULT_SHIP_SETTINGS, ...((await getSetting(env, "ship_settings")) || {}) };
}
export async function saveShipSettings(env, b) {
  const cur = await getShipSettings(env);
  const num = (v, min, max, d) => { const n = parseFloat(v); return n >= min && n <= max ? Math.round(n * 100) / 100 : d; };
  const str = (v, max, d) => { const s = String(v == null ? "" : v).trim().slice(0, max); return s || d; };
  const next = {
    w500: num(b.w500, 0.05, 30, cur.w500), w1kg: num(b.w1kg, 0.05, 30, cur.w1kg),
    length: num(b.length, 1, 200, cur.length), width: num(b.width, 1, 200, cur.width), height: num(b.height, 1, 200, cur.height),
    sender_name: str(b.sender_name, 80, cur.sender_name), sender_phone: str(b.sender_phone, 20, cur.sender_phone).replace(/\D/g, ""),
    sender_email: str(b.sender_email, 120, cur.sender_email), sender_addr1: str(b.sender_addr1, 120, cur.sender_addr1),
    sender_addr2: String(b.sender_addr2 == null ? cur.sender_addr2 : b.sender_addr2).trim().slice(0, 120),
    sender_postcode: str(b.sender_postcode, 5, cur.sender_postcode), sender_city: str(b.sender_city, 60, cur.sender_city),
    sender_state: SUBDIVISION[b.sender_state] ? b.sender_state : cur.sender_state,
    preferred: str(b.preferred, 30, cur.preferred)
  };
  await setSetting(env, "ship_settings", next);
  return next;
}

function basicAuth(env) {
  return "Basic " + btoa(env.EASYPARCEL_CLIENT_ID + ":" + env.EASYPARCEL_CLIENT_SECRET);
}
export function epConfigured(env) { return Boolean(env.EASYPARCEL_CLIENT_ID && env.EASYPARCEL_CLIENT_SECRET); }

async function tokenRequest(env, params) {
  // Token endpoint: cuba form-urlencoded dahulu (standard OAuth 2.0), kemudian JSON.
  const attempts = [
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() },
    { headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) }
  ];
  let last = null;
  for (const a of attempts) {
    const res = await fetch(EP_BASE + "/oauth/token", { method: "POST", headers: { "Authorization": basicAuth(env), "Accept": "application/json", ...a.headers }, body: a.body });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (res.ok && j && j.access_token) return j;
    last = { status: res.status, body: text.slice(0, 300) };
    if (res.status !== 400 && res.status !== 415) break;
  }
  throw new Error("Token EasyParcel gagal (" + (last && last.status) + "): " + (last && last.body));
}

function storeTokens(j) {
  const t = Date.now();
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at ? Date.parse(j.expires_at) : t + (Number(j.expires_in) || 36000) * 1000,
    refresh_expires_at: j.refresh_token_expires_at ? Date.parse(j.refresh_token_expires_at) : t + (Number(j.refresh_token_expires_in) || 31557600) * 1000,
    connected_at: nowIso()
  };
}

export async function startConnect(env, origin) {
  const state = crypto.randomUUID();
  await setSetting(env, "ep_oauth_state", { state, expires: Date.now() + 30 * 60 * 1000 });
  const u = new URL(EP_BASE + "/oauth/login");
  u.searchParams.set("client_id", env.EASYPARCEL_CLIENT_ID);
  u.searchParams.set("redirect_uri", origin + EP_REDIRECT_PATH);
  u.searchParams.set("state", state);
  return u.toString();
}

export async function handleCallback(env, url) {
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  const saved = await getSetting(env, "ep_oauth_state");
  await delSetting(env, "ep_oauth_state");
  if (!code) throw new Error("Tiada kod kebenaran dari EasyParcel.");
  if (!saved || saved.state !== state || saved.expires < Date.now()) throw new Error("Sesi sambungan tamat tempoh. Cuba Sambung EasyParcel semula.");
  const j = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: url.origin + EP_REDIRECT_PATH, state });
  await setSetting(env, "ep_tokens", storeTokens(j));
}

export async function disconnect(env) { await delSetting(env, "ep_tokens"); }

async function accessToken(env, origin, force) {
  const tk = await getSetting(env, "ep_tokens");
  if (!tk) throw new Error("EasyParcel belum disambung.");
  if (!force && tk.expires_at - Date.now() > 5 * 60 * 1000) return tk.access_token;
  if (!tk.refresh_token || tk.refresh_expires_at < Date.now()) throw new Error("Sambungan EasyParcel tamat tempoh. Tekan Sambung EasyParcel semula.");
  const j = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: tk.refresh_token, redirect_uri: origin + EP_REDIRECT_PATH });
  const next = storeTokens(j);
  if (!next.refresh_token) next.refresh_token = tk.refresh_token, next.refresh_expires_at = tk.refresh_expires_at;
  next.connected_at = tk.connected_at;
  await setSetting(env, "ep_tokens", next);
  return next.access_token;
}

async function ep(env, origin, method, path, body) {
  const call = async (token) => fetch(EP_API + path, {
    method, headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  let res = await call(await accessToken(env, origin, false));
  if (res.status === 401) res = await call(await accessToken(env, origin, true));
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!res.ok || !j) throw new Error("EasyParcel " + res.status + ": " + (j && j.message ? j.message : text.slice(0, 200)));
  return j;
}

export async function status(env, origin) {
  const tk = await getSetting(env, "ep_tokens");
  const out = { configured: epConfigured(env), connected: Boolean(tk), connected_at: tk && tk.connected_at, settings: await getShipSettings(env) };
  if (tk) {
    try {
      const w = await ep(env, origin, "GET", "/wallet");
      const bal = w.data && w.data.wallet && w.data.wallet[0];
      const free = w.data && w.data.free_credit_wallet && w.data.free_credit_wallet[0];
      out.balance = bal ? Number(bal.balance) : null;
      out.free_credit = free ? Number(free.balance) : 0;
    } catch (e) { out.error = e.message; }
  }
  return out;
}

// ---------- Parcel & pilihan kurier ----------
function parcelFor(order, s) {
  const items = JSON.parse(order.items);
  let weight = 0, value = 0;
  for (const it of items) {
    const per = it.size === "1kg" ? s.w1kg : it.size === "500g" ? s.w500 : 0.2;
    weight += per * it.qty;
    value += (it.line || 0) / 100;
  }
  weight = Math.max(0.1, Math.round(weight * 100) / 100);
  return { weight, value: Math.round(value * 100) / 100, items };
}
const tagValues = (c, name) => (c.service_tag || []).filter(t => t.name === name).map(t => String(t.value || ""));
function isDoorDelivery(q) {
  const m = tagValues(q.courier || {}, "Service Methods").join(" | ").toLowerCase();
  if (!m) return true;
  if (m.includes("deliver to door")) return true;
  return !/(locker|collect|self[- ]?pick|pick ?up point|point)/.test(m.replace("pick up from door", ""));
}
function priceOf(q) { const p = q.pricing || {}; return Number(p.seller_payable_amount != null ? p.seller_payable_amount : p.total_amount); }

export function chooseService(quotes, state, preferred) {
  const usable = quotes.filter(q => q && q.courier && q.courier.service_id && isFinite(priceOf(q)) && isDoorDelivery(q));
  const pickup = usable.filter(q => q.courier.is_pickup);
  const pool = pickup.length ? pickup : usable;
  const cheapest = list => list.slice().sort((a, b) => priceOf(a) - priceOf(b))[0] || null;
  let chosen = null, rule = "";
  if (!EAST.includes(state) && preferred) {
    const pref = pool.filter(q => (q.courier.courier_name + " " + q.courier.service_name).toUpperCase().includes(preferred.toUpperCase()));
    chosen = cheapest(pref);
    rule = chosen ? "preferred" : "fallback";
  }
  if (!chosen) { chosen = cheapest(pool); rule = rule || "cheapest"; }
  return { chosen, rule, options: pool.slice().sort((a, b) => priceOf(a) - priceOf(b)).slice(0, 8) };
}
function summarize(q) {
  return {
    service_id: q.courier.service_id, courier: q.courier.courier_name, service: q.courier.service_name,
    pickup: Boolean(q.courier.is_pickup), price: priceOf(q), duration: q.courier.delivery_duration || null
  };
}

export async function quote(env, origin, order) {
  const s = await getShipSettings(env);
  const p = parcelFor(order, s);
  const rc = SUBDIVISION[order.state];
  if (!rc) throw new Error("Negeri penerima tidak dikenali: " + order.state);
  const j = await ep(env, origin, "POST", "/shipment/quotations", {
    shipment: [{
      sender: { postcode: s.sender_postcode, subdivision_code: SUBDIVISION[s.sender_state], country: "MY" },
      receiver: { postcode: order.postcode, subdivision_code: rc, country: "MY" },
      parcel_value: p.value, weight: p.weight, width: s.width, length: s.length, height: s.height
    }]
  });
  const d = j.data && j.data[0];
  if (!d || d.status !== "success") throw new Error("Tiada harga dari EasyParcel untuk poskod " + order.postcode + ".");
  const pick = chooseService(d.quotations || [], order.state, s.preferred);
  if (!pick.chosen) throw new Error("Tiada kurier pickup + hantar ke pintu untuk poskod ini.");
  return { weight: p.weight, rule: pick.rule, chosen: summarize(pick.chosen), options: pick.options.map(summarize) };
}

function localPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("60")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return d;
}
function collectionDate() {
  const my = new Date(Date.now() + 8 * 3600 * 1000);
  if (my.getUTCHours() >= 12) my.setUTCDate(my.getUTCDate() + 1);
  return my.toISOString().slice(0, 10);
}

export async function book(env, origin, order, serviceId) {
  const s = await getShipSettings(env);
  const p = parcelFor(order, s);
  const items = p.items.map(it => ({
    content: "Coffee beans " + it.name + (it.size === "test" ? "" : " " + it.size),
    weight: it.size === "1kg" ? s.w1kg : it.size === "500g" ? s.w500 : 0.2,
    height: s.height, length: s.length, width: s.width,
    currency_code: "MYR", value: Math.round(it.unit) / 100, quantity: it.qty
  }));
  const j = await ep(env, origin, "POST", "/shipment/submit_orders", {
    shipment: [{
      reference: order.id,
      service_id: serviceId,
      collection_date: collectionDate(),
      weight: p.weight, height: s.height, length: s.length, width: s.width,
      item: items,
      sender: {
        name: s.sender_name, phone_number_country_code: "MY", phone_number: localPhone(s.sender_phone), email: s.sender_email,
        address_1: s.sender_addr1, address_2: s.sender_addr2 || undefined, postcode: s.sender_postcode, city: s.sender_city,
        subdivision_code: SUBDIVISION[s.sender_state], country_code: "MY"
      },
      receiver: {
        name: order.name, phone_number_country_code: "MY", phone_number: localPhone(order.phone), email: order.email,
        address_1: order.addr1, address_2: order.addr2 || undefined, postcode: order.postcode, city: order.city,
        subdivision_code: SUBDIVISION[order.state], country_code: "MY"
      },
      feature: { email_tracking: false, sms_tracking: false, whatsapp_tracking: false }
    }]
  });
  const d = j.data && j.data[0];
  const sh = d && d.shipments && d.shipments[0];
  if (!sh || sh.status !== "success") {
    const err = (j.errors && JSON.stringify(j.errors)) || (sh && (sh.message || JSON.stringify(sh.errors || sh))) || j.message;
    throw new Error("Booking gagal: " + String(err).slice(0, 300));
  }
  const cost = Number((sh.pricing_breakdown && sh.pricing_breakdown.total_paid_amount) || (d.pricing_breakdown && d.pricing_breakdown.total_paid_amount) || 0);
  return {
    ship_number: sh.shipment_number, courier: sh.courier || null, awb_number: sh.awb_number || null,
    awb_url: sh.awb_url || (sh.awb_urls_by_format && (sh.awb_urls_by_format.A6 || sh.awb_urls_by_format.A4)) || null,
    tracking_url: sh.tracking_url || null, cost_sen: Math.round(cost * 100)
  };
}

export async function details(env, origin, shipNumber) {
  const j = await ep(env, origin, "POST", "/shipment/details", { shipment_number: shipNumber });
  const d = j.data && j.data[0];
  const sd = d && d.shipment_details;
  if (!sd) throw new Error("Butiran shipment tidak dijumpai.");
  return { awb_number: sd.awb_number || null, awb_url: sd.awb_url || null, tracking_url: sd.tracking_url || null, status: sd.shipment_status || null };
}
