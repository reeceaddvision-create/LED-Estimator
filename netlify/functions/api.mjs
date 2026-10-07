// LED Estimator API: one Netlify Function for every /api/* route.
//
//   GET    /api/config              products, extras and settings (public)
//   PUT    /api/config              save them (admin) + keep a history copy
//   GET    /api/history             saved versions (admin)
//   POST   /api/restore             { key } bring back a version (admin)
//   POST   /api/login               { password } -> { token }
//   POST   /api/upload              logo/image upload (admin) -> { url }
//   GET    /api/file/<key>          serve an uploaded file (public)
//   POST   /api/enquiry             customer submits a quote request (public) -> { ref }
//   GET    /api/enquiries           list enquiries (admin)
//   GET    /api/enquiry/<id>        one enquiry (admin)
//   PATCH  /api/enquiry/<id>        { status, note } (admin)
//   DELETE /api/enquiry/<id>        (admin)
//
// Netlify environment variables: ADMIN_PASSWORD (required), SESSION_SECRET (recommended)

import { getStore } from "@netlify/blobs";

const MAX_UPLOAD = 6 * 1024 * 1024;
const MAX_MOCKUP = 3 * 1024 * 1024;
const HISTORY_KEEP = 20;
const SESSION_HOURS = 12;

const store = (name) => (globalThis.__memStores ? globalThis.__memStores(name) : getStore({ name, consistency: "strong" }));
const env = (k) => globalThis.Netlify?.env?.get?.(k) ?? process.env[k];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status, message) => json({ error: message }, status);

const enc = new TextEncoder();
async function hmac(text) {
  const secret = env("SESSION_SECRET") || "led:" + (env("ADMIN_PASSWORD") || "");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, enc.encode(text))).toString("base64url");
}
const same = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
async function isAdmin(req) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  const [exp, sig] = t.split(".");
  return !!exp && !!sig && Number(exp) > Date.now() && same(await hmac(exp), sig);
}
const hits = new Map();
function limited(key, max, mins) {
  const now = Date.now(), list = (hits.get(key) || []).filter((t) => now - t < mins * 60e3);
  list.push(now); hits.set(key, list); return list.length > max;
}
const clean = (s, n = 200) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const validConfig = (c) => c && c.settings && Array.isArray(c.products) && c.products.length > 0 && Array.isArray(c.extras);

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const m = req.method;
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "x";
  const cfgStore = store("config");

  try {
    // ---------- public ----------
    if (path === "config" && m === "GET") {
      const c = await cfgStore.get("current", { type: "json" });
      return c ? json(c) : fail(404, "Not set up yet");
    }
    if (path.startsWith("file/") && m === "GET") {
      const r = await store("uploads").getWithMetadata(decodeURIComponent(path.slice(5)), { type: "arrayBuffer" });
      if (!r) return new Response("Not found", { status: 404 });
      return new Response(r.data, { headers: { "content-type": r.metadata?.type || "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" } });
    }
    if (path === "enquiry" && m === "POST") {
      if (limited("enq:" + ip, 8, 60)) return fail(429, "Too many requests. Please try again later.");
      const b = await req.json().catch(() => null);
      if (!b || !b.customer || !b.quote) return fail(400, "Something was missing from the form.");
      const c = b.customer;
      if (!clean(c.name) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean(c.email))) return fail(400, "Please enter your name and a valid email address.");
      const now = new Date();
      const ref = "LED-" + now.toISOString().slice(2, 10).replace(/-/g, "") + "-" + crypto.randomUUID().slice(0, 4).toUpperCase();
      let mockupKey = "";
      if (typeof b.mockup === "string" && b.mockup.startsWith("data:image/jpeg;base64,")) {
        const buf = Buffer.from(b.mockup.split(",")[1], "base64");
        if (buf.byteLength <= MAX_MOCKUP) { mockupKey = "mockup-" + ref + ".jpg"; await store("uploads").set(mockupKey, buf, { metadata: { type: "image/jpeg" } }); }
      }
      const q = b.quote;
      const record = {
        id: ref, ref, createdAt: now.toISOString(), status: "new", note: "",
        customer: { name: clean(c.name, 100), company: clean(c.company, 120), email: clean(c.email, 160), phone: clean(c.phone, 40), postcode: clean(c.postcode, 20), message: clean(c.message, 2000) },
        quote: {
          productId: clean(q.productId, 40), productName: clean(q.productName, 80), environment: clean(q.environment, 20),
          requested: { width: Number(q.requested?.width) || 0, height: Number(q.requested?.height) || 0, distance: Number(q.requested?.distance) || 0 },
          width: Number(q.width) || 0, height: Number(q.height) || 0, area: Number(q.area) || 0, panels: Number(q.panels) || 0, resolution: clean(q.resolution, 30),
          lines: Array.isArray(q.lines) ? q.lines.slice(0, 20).map((l) => ({ name: clean(l.name, 160), amount: Number(l.amount) || 0 })) : [],
          subtotal: Number(q.subtotal) || 0, vat: Number(q.vat) || 0, total: Number(q.total) || 0
        },
        mockup: mockupKey ? "/api/file/" + mockupKey : ""
      };
      await store("enquiries").setJSON(ref, record);
      return json({ ok: true, ref, date: now.toISOString() });
    }
    if (path === "login" && m === "POST") {
      if (limited("login:" + ip, 10, 10)) return fail(429, "Too many attempts. Wait 10 minutes and try again.");
      const want = env("ADMIN_PASSWORD");
      if (!want) return fail(500, "The admin password hasn't been set up yet. Add ADMIN_PASSWORD in Netlify → Environment variables, then redeploy.");
      const { password } = await req.json().catch(() => ({}));
      if (typeof password !== "string" || password !== want) return fail(401, "That password isn't right.");
      const exp = String(Date.now() + SESSION_HOURS * 3600e3);
      return json({ token: `${exp}.${await hmac(exp)}` });
    }

    // ---------- admin ----------
    if (!(await isAdmin(req))) return fail(401, "Please log in again.");

    if (path === "session") return json({ ok: true });

    if (path === "config" && m === "PUT") {
      const c = await req.json().catch(() => null);
      if (!validConfig(c)) return fail(400, "Those settings couldn't be saved. You need at least one product.");
      c.savedAt = new Date().toISOString();
      await cfgStore.setJSON("current", c);
      await cfgStore.setJSON("history/" + c.savedAt, c);
      const { blobs } = await cfgStore.list({ prefix: "history/" });
      await Promise.all(blobs.map((x) => x.key).sort().slice(0, -HISTORY_KEEP).map((k) => cfgStore.delete(k)));
      return json({ ok: true, savedAt: c.savedAt });
    }
    if (path === "history" && m === "GET") {
      const { blobs } = await cfgStore.list({ prefix: "history/" });
      return json(blobs.map((b) => b.key).sort().reverse().map((key) => ({ key, at: key.slice(8) })));
    }
    if (path === "restore" && m === "POST") {
      const { key } = await req.json().catch(() => ({}));
      if (typeof key !== "string" || !key.startsWith("history/")) return fail(400, "Unknown version");
      const v = await cfgStore.get(key, { type: "json" });
      return v ? json(v) : fail(404, "That version no longer exists.");
    }
    if (path === "upload" && m === "POST") {
      const type = (req.headers.get("content-type") || "").split(";")[0];
      if (!/^image\/(jpeg|png|webp|svg\+xml)$/.test(type)) return fail(415, "Please upload a JPG, PNG, WebP or SVG image.");
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_UPLOAD) return fail(413, "That image is too big. Keep it under 6 MB.");
      const key = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${type.split("/")[1].replace("+xml", "").replace("jpeg", "jpg")}`;
      await store("uploads").set(key, buf, { metadata: { type } });
      return json({ url: "/api/file/" + key });
    }
    if (path === "enquiries" && m === "GET") {
      const es = store("enquiries"); const { blobs } = await es.list();
      const all = (await Promise.all(blobs.map((b) => es.get(b.key, { type: "json" })))).filter(Boolean);
      all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(all);
    }
    if (path.startsWith("enquiry/")) {
      const id = decodeURIComponent(path.slice(8)); const es = store("enquiries");
      const rec = await es.get(id, { type: "json" });
      if (!rec) return fail(404, "That enquiry no longer exists.");
      if (m === "GET") return json(rec);
      if (m === "PATCH") {
        const b = await req.json().catch(() => ({}));
        if (["new", "contacted", "quoted", "won", "lost"].includes(b.status)) rec.status = b.status;
        if (typeof b.note === "string") rec.note = clean(b.note, 4000);
        await es.setJSON(id, rec); return json(rec);
      }
      if (m === "DELETE") {
        await es.delete(id);
        if (rec.mockup) await store("uploads").delete(rec.mockup.replace("/api/file/", ""));
        return json({ ok: true });
      }
    }
    return fail(404, "Unknown request");
  } catch (e) {
    console.error(e);
    return fail(500, "Something went wrong on the server. Please try again in a minute.");
  }
};

export const config = { path: "/api/*" };
