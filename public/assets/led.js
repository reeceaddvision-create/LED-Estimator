/* LED Estimator shared logic: pricing, perspective mockup, PDF. Used by / and /admin. */
(function (g) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d = 0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
  const money = (n, cur = "£") => cur + Math.round(n).toLocaleString("en-GB");
  const fmt = (n, dp = 2) => Number(n).toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });

  /* ---------- pricing ---------- */
  function extrasFor(cfg, product) {
    return (cfg.extras || []).filter((x) => x.visible !== false && (x.appliesTo === "all" || x.appliesTo === product.environment));
  }
  function calc(cfg, input) {
    const p = (cfg.products || []).find((x) => x.id === input.productId) || cfg.products[0];
    const cw = num(p.cabinetW, 500), ch = num(p.cabinetH, 500);
    const cols = Math.max(1, Math.round((num(input.width) * 1000) / cw));
    const rows = Math.max(1, Math.round((num(input.height) * 1000) / ch));
    const w = (cols * cw) / 1000, h = (rows * ch) / 1000, area = w * h;
    const resW = Math.round((w * 1000) / p.pitch), resH = Math.round((h * 1000) / p.pitch);
    const screen = area * num(p.pricePerM2);
    const lines = [{ id: "screen", name: `${p.name} LED screen (${fmt(area)} m² at ${money(p.pricePerM2, cfg.settings.currency)}/m²)`, amount: screen, kind: "screen" }];
    const chosen = input.extras || {};
    for (const x of extrasFor(cfg, p)) {
      const on = x.mode === "included" ? true : (x.id in chosen ? !!chosen[x.id] : x.mode === "optional-on");
      const amount = x.type === "perM2" ? num(x.amount) * area : x.type === "percent" ? (num(x.amount) / 100) * screen : num(x.amount);
      lines.push({ id: x.id, name: x.name, amount, on, optional: x.mode !== "included", type: x.type, rate: num(x.amount) });
    }
    const subtotal = lines.filter((l) => l.kind === "screen" || l.on).reduce((s, l) => s + l.amount, 0);
    const vat = (subtotal * num(cfg.settings.vatRate)) / 100;
    return {
      product: p, cols, rows, panels: cols * rows, width: w, height: h, area, resW, resH,
      aspect: w / h, powerMax: area * num(p.powerMax), powerAvg: area * num(p.powerAvg), weight: area * num(p.weight),
      minViewing: p.pitch * 1, lines, subtotal, vat, total: subtotal + vat
    };
  }
  // Pick the most affordable product that still looks sharp from the given distance (rule of thumb: 1 m per mm of pixel pitch).
  function recommend(cfg, env, distance) {
    const list = (cfg.products || []).filter((p) => p.visible !== false && p.environment === env).sort((a, b) => a.pitch - b.pitch);
    if (!list.length) return null;
    const ok = list.filter((p) => p.pitch <= distance);
    return (ok.length ? ok[ok.length - 1] : list[0]).id;
  }

  /* ---------- perspective (homography) ---------- */
  function solve(A, b) { // Gaussian elimination, 8x8
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  // maps (0,0),(w,0),(w,h),(0,h) -> quad [tl,tr,br,bl]
  function homography(w, h, q) {
    const src = [[0, 0], [w, 0], [w, h], [0, h]], A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = q[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const s = solve(A, b);
    return [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], 1];
  }
  function matrix3d(H) {
    const [a, b, c, d, e, f, gg, hh, i] = H;
    return `matrix3d(${a},${d},0,${gg},${b},${e},0,${hh},0,0,1,0,${c},${f},0,${i})`;
  }
  function invert(m) {
    const [a, b, c, d, e, f, g2, h, i] = m, A = e * i - f * h, B = -(d * i - f * g2), C = d * h - e * g2, det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g2) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g2) / det, (a * e - b * d) / det];
  }
  // Render photo + warped content into a canvas (used for the PDF and saved enquiry).
  function renderMockup(photo, content, quad, opts = {}) {
    const W = photo.naturalWidth || photo.width, Hh = photo.naturalHeight || photo.height;
    const scale = Math.min(1, (opts.maxSize || 1800) / Math.max(W, Hh));
    const cw = Math.round(W * scale), chh = Math.round(Hh * scale);
    const out = document.createElement("canvas"); out.width = cw; out.height = chh;
    const x = out.getContext("2d"); x.drawImage(photo, 0, 0, cw, chh);
    const q = quad.map(([u, v]) => [u * cw, v * chh]);
    const sw = content.width, sh = content.height;
    const src = content.getContext("2d").getImageData(0, 0, sw, sh).data;
    const Hm = homography(sw, sh, q), Hi = invert(Hm);
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(cw - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(chh - 1, Math.ceil(Math.max(...ys)));
    if (x1 > x0 && y1 > y0) {
      const img = x.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1), d = img.data, bw = x1 - x0 + 1;
      const bright = opts.brightness ?? 1;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        const px = xx + 0.5, py = yy + 0.5, z = Hi[6] * px + Hi[7] * py + Hi[8];
        const sx = (Hi[0] * px + Hi[1] * py + Hi[2]) / z, sy = (Hi[3] * px + Hi[4] * py + Hi[5]) / z;
        if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue;
        const si = ((sy | 0) * sw + (sx | 0)) * 4, di = ((yy - y0) * bw + (xx - x0)) * 4;
        d[di] = Math.min(255, src[si] * bright); d[di + 1] = Math.min(255, src[si + 1] * bright); d[di + 2] = Math.min(255, src[si + 2] * bright); d[di + 3] = 255;
      }
      x.putImageData(img, x0, y0);
    }
    // thin frame
    x.strokeStyle = "rgba(20,20,20,.9)"; x.lineWidth = Math.max(2, cw / 500); x.beginPath(); q.forEach((p, i) => (i ? x.lineTo(...p) : x.moveTo(...p))); x.closePath(); x.stroke();
    return out;
  }

  /* ---------- sample artwork for the screen ---------- */
  function sampleContent(kind, aspect, brand, accent) {
    const H = 540, W = Math.max(200, Math.min(2400, Math.round(H * aspect)));
    const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
    if (kind === "sale") {
      const gr = x.createLinearGradient(0, 0, W, H); gr.addColorStop(0, "#ff3d6e"); gr.addColorStop(1, "#ffb300"); x.fillStyle = gr; x.fillRect(0, 0, W, H);
      x.fillStyle = "#fff"; x.textAlign = "center"; x.textBaseline = "middle";
      x.font = `900 ${Math.min(H * .34, W * .2)}px system-ui,sans-serif`; x.fillText("SALE", W / 2, H * .42);
      x.font = `700 ${Math.min(H * .1, W * .07)}px system-ui,sans-serif`; x.fillText("Up to 50% off this weekend", W / 2, H * .72);
    } else if (kind === "menu") {
      x.fillStyle = "#111"; x.fillRect(0, 0, W, H);
      x.fillStyle = "#f5c518"; x.font = `800 ${H * .12}px system-ui,sans-serif`; x.textBaseline = "top"; x.fillText("TODAY'S MENU", W * .06, H * .08);
      x.font = `600 ${H * .075}px system-ui,sans-serif`;
      [["Flat white", "£3.20"], ["Breakfast roll", "£4.50"], ["Soup of the day", "£5.00"], ["Club sandwich", "£6.75"]].forEach(([a, b], i) => {
        x.fillStyle = "#fff"; x.textAlign = "left"; x.fillText(a, W * .06, H * (.32 + i * .15)); x.textAlign = "right"; x.fillStyle = "#f5c518"; x.fillText(b, W * .94, H * (.32 + i * .15));
      });
    } else {
      const gr = x.createLinearGradient(0, 0, W, H); gr.addColorStop(0, "#0b1033"); gr.addColorStop(1, accent || "#2563eb"); x.fillStyle = gr; x.fillRect(0, 0, W, H);
      for (let i = 0; i < 6; i++) { x.fillStyle = `rgba(255,255,255,${.04 + i * .015})`; x.beginPath(); x.arc(W * (.15 + i * .16), H * (.2 + (i % 3) * .3), H * (.12 + i * .03), 0, 7); x.fill(); }
      x.fillStyle = "#fff"; x.textAlign = "center"; x.textBaseline = "middle";
      x.font = `800 ${Math.min(H * .2, W * .1)}px system-ui,sans-serif`; x.fillText(brand || "Your brand", W / 2, H * .45);
      x.font = `500 ${Math.min(H * .07, W * .045)}px system-ui,sans-serif`; x.fillText("Your content here", W / 2, H * .66);
    }
    return c;
  }
  function imageToCanvas(img, aspect) { // cover-fit into screen aspect
    const H = 720, W = Math.round(Math.min(2400, H * aspect)); const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d"), r = Math.max(W / img.naturalWidth, H / img.naturalHeight), dw = img.naturalWidth * r, dh = img.naturalHeight * r;
    x.fillStyle = "#000"; x.fillRect(0, 0, W, H); x.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh); return c;
  }
  // A plain building photo stand-in, used until the customer uploads their own.
  function sampleSite(env) {
    const W = 1600, H = 1000, c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
    if (env === "indoor") {
      x.fillStyle = "#d9d4cc"; x.fillRect(0, 0, W, H);
      const fl = x.createLinearGradient(0, H * .72, 0, H); fl.addColorStop(0, "#8b6e55"); fl.addColorStop(1, "#5d4634"); x.fillStyle = fl; x.fillRect(0, H * .72, W, H * .28);
      x.fillStyle = "#c9c3b9"; x.fillRect(0, H * .7, W, H * .025);
      x.fillStyle = "#2f3a4a"; x.fillRect(W * .62, H * .52, W * .3, H * .2); x.fillStyle = "#3d4a5c"; x.fillRect(W * .6, H * .5, W * .34, H * .03);
      for (let i = 0; i < 3; i++) { x.fillStyle = "#e9e4dc"; x.fillRect(W * (.08 + i * .06), H * .08, 8, H * .62); }
      x.fillStyle = "rgba(255,255,255,.35)"; x.fillRect(0, 0, W, H * .05);
    } else {
      const sky = x.createLinearGradient(0, 0, 0, H * .6); sky.addColorStop(0, "#7fb3e0"); sky.addColorStop(1, "#d6e8f5"); x.fillStyle = sky; x.fillRect(0, 0, W, H);
      x.fillStyle = "#b9a48d"; x.fillRect(W * .08, H * .12, W * .84, H * .7);
      for (let r = 0; r < 14; r++) for (let k = 0; k < 30; k++) { x.fillStyle = (r + k) % 2 ? "rgba(0,0,0,.035)" : "rgba(255,255,255,.04)"; x.fillRect(W * .08 + k * W * .028, H * .12 + r * H * .05, W * .028, H * .05); }
      x.fillStyle = "#3c4752"; for (let k = 0; k < 5; k++) x.fillRect(W * (.14 + k * .155), H * .6, W * .1, H * .22);
      x.fillStyle = "#59636d"; x.fillRect(0, H * .82, W, H * .18); x.fillStyle = "#6b757f"; x.fillRect(0, H * .82, W, H * .02);
      x.fillStyle = "#8d7a66"; x.fillRect(W * .06, H * .1, W * .88, H * .025);
    }
    return c;
  }

  /* ---------- PDF ---------- */
  async function loadImg(src) { return new Promise((res) => { if (!src) return res(null); const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }
  function hexRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ""); const n = m ? parseInt(m[1], 16) : 0x2563eb; return [n >> 16, (n >> 8) & 255, n & 255]; }
  async function buildPdf(cfg, q, info) {
    const { jsPDF } = window.jspdf; const s = cfg.settings, cur = s.currency || "£";
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const _t = doc.text.bind(doc), fix = (v) => Array.isArray(v) ? v.map(fix) : String(v).replace(/m²/g, "sq m").replace(/²/g, "2");
    doc.text = (v, ...r) => _t(fix(v), ...r); const W = 210, M = 16; const acc = hexRgb(s.accent);
    doc.setFillColor(...acc); doc.rect(0, 0, W, 30, "F");
    const logo = await loadImg(s.logo);
    if (logo) { const c = document.createElement("canvas"); c.width = logo.naturalWidth; c.height = logo.naturalHeight; c.getContext("2d").drawImage(logo, 0, 0); const r = logo.naturalWidth / logo.naturalHeight; const h = 14, w = Math.min(60, h * r); doc.addImage(c.toDataURL("image/png"), "PNG", M, 8, w, w / r); }
    else { doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.text(s.companyName || "", M, 19); }
    doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.text("LED SCREEN ESTIMATE", W - M, 14, { align: "right" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text(`Ref ${info.ref}   ·   ${info.date}`, W - M, 21, { align: "right" });
    let y = 40; doc.setTextColor(30, 35, 50);
    doc.setFontSize(9); doc.setTextColor(110, 116, 135); doc.text("PREPARED FOR", M, y); doc.text("VALID UNTIL", 120, y);
    doc.setTextColor(30, 35, 50); doc.setFontSize(11); doc.setFont("helvetica", "bold");
    doc.text([info.name, info.company].filter(Boolean).join(", ") || "-", M, y + 6); doc.text(info.validUntil, 120, y + 6);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text([info.email, info.phone, info.postcode].filter(Boolean).join("   ·   "), M, y + 11);
    y += 20;
    if (info.mockup) {
      const r = info.mockupW / info.mockupH; let w = W - 2 * M, h = w / r; if (h > 82) { h = 82; w = h * r; }
      doc.addImage(info.mockup, "JPEG", (W - w) / 2, y, w, h); y += h + 3;
      doc.setFontSize(8); doc.setTextColor(110, 116, 135); doc.text("Visualisation for illustration only.", W / 2, y + 2, { align: "center" }); y += 8;
    }
    // specs
    doc.setTextColor(30, 35, 50); doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.text("Your screen", M, y); y += 5;
    const specs = [["Product", q.product.name], ["Pixel pitch", q.product.pitch + " mm"], ["Size", `${fmt(q.width)} m × ${fmt(q.height)} m  (${fmt(q.area)} m²)`],
      ["Panels", `${q.cols} × ${q.rows} = ${q.panels}`], ["Resolution", `${q.resW} × ${q.resH} pixels`], ["Brightness", `${q.product.brightness} nits`],
      ["Best viewed from", `${fmt(q.minViewing, 1)} m and further`], ["Power (typical / max)", `${fmt(q.powerAvg / 1000, 1)} kW / ${fmt(q.powerMax / 1000, 1)} kW`], ["Weight (approx.)", `${Math.round(q.weight)} kg`]];
    doc.setFontSize(9);
    specs.forEach(([a, b], i) => { const cx = i % 2 ? 108 : M, cy = y + Math.floor(i / 2) * 6.2; doc.setFont("helvetica", "normal"); doc.setTextColor(110, 116, 135); doc.text(a, cx, cy + 4); doc.setTextColor(30, 35, 50); doc.setFont("helvetica", "bold"); doc.text(String(b), cx + 36, cy + 4); });
    y += Math.ceil(specs.length / 2) * 6.2 + 6;
    if (y > 215) { doc.addPage(); y = 20; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.text("Estimate", M, y); y += 3;
    doc.setFontSize(9.5);
    const rows = q.lines.filter((l) => l.kind === "screen" || l.on);
    rows.forEach((l) => { y += 7; doc.setDrawColor(228, 231, 240); doc.line(M, y + 2.2, W - M, y + 2.2); doc.setFont("helvetica", "normal"); doc.text(doc.splitTextToSize(l.name, 140)[0], M, y); doc.text(money(l.amount, cur), W - M, y, { align: "right" }); });
    y += 9; doc.setFont("helvetica", "normal"); doc.text("Subtotal", 120, y); doc.text(money(q.subtotal, cur), W - M, y, { align: "right" });
    y += 6; doc.text(`${s.vatLabel || "VAT"} (${s.vatRate}%)`, 120, y); doc.text(money(q.vat, cur), W - M, y, { align: "right" });
    y += 3; doc.setFillColor(...acc); doc.rect(116, y, W - M - 116, 10, "F"); doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.text("Estimated total", 120, y + 6.6); doc.text(money(q.total, cur), W - M - 3, y + 6.6, { align: "right" });
    y += 17; doc.setTextColor(110, 116, 135); doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    const terms = doc.splitTextToSize(s.terms || "", W - 2 * M);
    if (y + terms.length * 3.6 > 278) { doc.addPage(); y = 20; }
    doc.text(terms, M, y);
    const pages = doc.getNumberOfPages();
    for (let pg = 1; pg <= pages; pg++) { doc.setPage(pg); doc.setDrawColor(...acc); doc.line(M, 283, W - M, 283); doc.setFontSize(8.5); doc.setTextColor(30, 35, 50);
      doc.text([s.companyName, s.contactEmail, s.contactPhone, s.website].filter(Boolean).join("   ·   "), W / 2, 289, { align: "center" }); }
    return doc;
  }

  g.LED = { esc, num, money, fmt, calc, recommend, extrasFor, homography, matrix3d, renderMockup, sampleContent, imageToCanvas, sampleSite, buildPdf };
})(window);
