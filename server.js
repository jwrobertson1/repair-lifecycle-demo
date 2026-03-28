/************************************************************
 * RepairFlow Warranty API — server.js
 * Node 18+, Render-compatible
 ************************************************************/
const express = require("express");
const fetch = require("node-fetch");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 4000;

/************************************************************
 * MIDDLEWARE
 ************************************************************/
app.use(express.json());
app.use(express.static("Public"));
app.get("/__version", (req, res) => {
  res.json({
    status: "ok",
    message: "LOOKUP ROUTE VERSION CHECK",
    timestamp: new Date().toISOString()
  });
});

/************************************************************
 * APPS SCRIPT HELPER — sends payload as GET query param
 * because Google redirects POST to GET
 ************************************************************/
async function scriptFetch(payload) {
  const url = process.env.PHASE2_SCRIPT_URL + "?payload=" + encodeURIComponent(JSON.stringify(payload));
  const r = await fetch(url);
  return r;
}

/************************************************************
 * SHARED NAV BAR
 ************************************************************/
function navBar(active) {
  const links = [
    { href: "/", label: "Warranty Form" },
    { href: "/internal/intake", label: "Intake" },
    { href: "/internal/production", label: "Production" },
    { href: "/internal/qc", label: "QC" },
    { href: "/analytics.html", label: "Analytics" },
  ];
  const linkHtml = links.map(l =>
    `<a href="${l.href}" style="color:${l.label === active ? '#fff' : '#ccc'};text-decoration:none;font-size:0.85rem;font-weight:600;padding:6px 12px;border-radius:4px;background:${l.label === active ? '#0b8457' : 'transparent'}">${l.label}</a>`
  ).join("");
  return `<nav style="background:#1a1a2e;padding:12px 24px;display:flex;align-items:center;gap:16px;">
  <div style="font-size:1.2rem;font-weight:800;color:#fff;letter-spacing:-0.5px;margin-right:8px;">Repair<span style="color:#0b8457">Flow</span></div>
  ${linkHtml}
</nav>`;
}

/************************************************************
 * INTERNAL AUTH GATE
 ************************************************************/
function requireInternal(req, res, next) {
  const expected = process.env.RF_INTERNAL_KEY;
  if (!expected) return res.status(401).send("Unauthorized");

  const headerKey = req.headers["x-rf-key"];

  const cookie = req.headers.cookie || "";
  const cookieKey = cookie
    .split(";")
    .map(x => x.trim())
    .find(x => x.startsWith("repairflow_internal_key="));

  const cookieVal = cookieKey ? cookieKey.split("=")[1] : null;

  if (headerKey === expected || cookieVal === expected) return next();
  return res.status(401).send("Unauthorized");
}

/************************************************************
 * QUICK HEALTH CHECK
 ************************************************************/
app.get("/ping", (req, res) => {
  res.json({ status: "ok", message: "RepairFlow is live" });
});

/************************************************************
 * INTERNAL LOGIN HELPER
 ************************************************************/
app.get("/internal/login", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    `repairflow_internal_key=${process.env.RF_INTERNAL_KEY}; Path=/; Max-Age=86400; SameSite=Lax`
  );
  res.send("Logged in ✅ You can now open /internal/intake");
});

/************************************************************
 * SMTP (GMAIL APP PASSWORD)
 ************************************************************/
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

/************************************************************
 * EMAIL HELPERS
 ************************************************************/
async function sendCSEmail(data, rowNumber) {
  await transporter.sendMail({
    from: `"RepairFlow Warranty" <${process.env.SMTP_USER}>`,
    to: process.env.CS_EMAIL,
    subject: `New Warranty Claim – Order ${data.originalOrderNumber || "N/A"}`,
    text:
      `New warranty claim submitted\n\n` +
      `Customer: ${data.customerName || ""}\n` +
      `Email: ${data.customerEmail || ""}\n` +
      `Phone: ${data.customerPhone || ""}\n\n` +
      `Source: ${data.source || ""}\n` +
      `Order #: ${data.originalOrderNumber || ""}\n` +
      `Warranty #: ${data.originalWarrantyNumber || ""}\n` +
      `Product: ${data.product || ""}\n` +
      `UPC: ${data.upc || ""}\n\n` +
      `Issue:\n${data.issueDescription || ""}\n\n` +
      `Sheet Row: ${rowNumber || ""}`
  });
}

async function sendCustomerEmail(data) {
  if (!data.customerEmail) return;

  await transporter.sendMail({
    from: `"RepairFlow" <${process.env.SMTP_USER}>`,
    to: data.customerEmail,
    subject: "We received your warranty claim",
    text:
      `Hello ${data.customerName || ""},\n\n` +
      `We've received your warranty claim and our team will review it shortly.\n\n` +
      `Order #: ${data.originalOrderNumber || ""}\n` +
      `Warranty #: ${data.originalWarrantyNumber || ""}\n` +
      `Product: ${data.product || ""}\n\n` +
      `Issue:\n${data.issueDescription || ""}\n\n` +
      `If any of this looks incorrect, please reply to this email.\n\n` +
      `Thank you,\nRepairFlow`
  });
}

/************************************************************
 * WARRANTY SUBMISSION ENDPOINT
 ************************************************************/
app.post("/warranty", async (req, res) => {
  try {
    const r = await scriptFetch(req.body);

    if (!r.ok) throw new Error(await r.text());
    const result = await r.json();

    await sendCSEmail(req.body, result.row);
    await sendCustomerEmail(req.body);

    res.json({ status: "ok", row: result.row || null });

  } catch (err) {
    console.error("Warranty submission failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/************************************************************
 * WARRANTY LOOKUP
 ************************************************************/
app.get("/warranty/lookup", async (req, res) => {
  try {
    const order = String(req.query.order || "").trim();
    if (!order) {
      return res.status(400).json({ status: "error", message: "Missing order" });
    }

    const scriptUrl = process.env.PHASE2_SCRIPT_URL;
    if (!scriptUrl) {
      return res.status(500).json({
        status: "error",
        message: "Missing env var PHASE2_SCRIPT_URL"
      });
    }

    const payload = {
      action: "lookup",
      key: process.env.PHASE2_KEY || "repairflow_phase2_demo",
      originalOrderNumber: order
    };

    const r = await scriptFetch(payload);
    const text = await r.text();

    try {
      return res.json(JSON.parse(text));
    } catch {
      return res.status(502).json({
        status: "error",
        message: "Apps Script did not return JSON",
        preview: text.slice(0, 200)
      });
    }
  } catch (err) {
    console.error("LOOKUP ERROR:", err);
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/************************************************************
 * PHASE 2 INTERNAL PROXY API
 ************************************************************/
app.post("/internal/api/phase2", requireInternal, async (req, res) => {
  try {
    const scriptUrl = process.env.PHASE2_SCRIPT_URL;
    const key = process.env.PHASE2_KEY;

    if (!scriptUrl) throw new Error("Missing env var PHASE2_SCRIPT_URL");
    if (!key) throw new Error("Missing env var PHASE2_KEY");

    const payload = { ...req.body, key };
    const r = await scriptFetch(payload);
    const text = await r.text();

    try {
      const data = JSON.parse(text);
      return res.json(data);
    } catch (jsonErr) {
      console.error("Phase 2 proxy returned non-JSON:", text.slice(0, 600));
      return res.status(500).json({
        status: "error",
        message: "Phase 2 Apps Script did not return JSON.",
        preview: text.slice(0, 600)
      });
    }

  } catch (err) {
    console.error("Phase 2 proxy error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

/************************************************************
 * INTERNAL PAGES: INTAKE
 ************************************************************/
app.get("/internal/intake", requireInternal, (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>RepairFlow – Receiving Intake</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f4f5f7; }
    .page { max-width: 700px; margin: 32px auto; background: #fff; padding: 28px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h2 { font-size: 1.3rem; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; }
    .sub { color: #888; font-size: 0.8rem; margin-bottom: 20px; }
    label { font-weight: 600; display:block; margin-top:12px; font-size:0.85rem; }
    input, select { width:100%; padding:10px; margin-top:4px; border:1px solid #ddd; border-radius:6px; font-size:0.9rem; }
    button.primary { background:#0b8457; color:#fff; border:none; padding:10px 16px; border-radius:6px; cursor:pointer; font-weight:600; margin-top:8px; }
    button.primary:hover { background:#096e47; }
    .result { border:1px solid #e0e0e0; padding:16px; border-radius:8px; margin-top:20px; }
    .field { margin-bottom:8px; font-size:0.9rem; }
    .ok { color: #0b8457; font-weight:600; }
    .err { color: #dc2626; font-weight:600; }
    hr { border:none; border-top:1px solid #eee; margin:16px 0; }
  </style>
</head>
<body>
${navBar("Intake")}
<div class="page">
  <h2>Receiving Intake</h2>
  <p class="sub">Lookup by Original Order # → Update Intake Stage + auto-assign Internal Warranty #</p>

  <label>Original Order #</label>
  <div style="display:flex;gap:8px;margin-top:4px;">
    <input id="order" placeholder="Enter order number" style="flex:1" />
    <button class="primary" onclick="lookup()">Lookup</button>
  </div>

  <div id="result" class="result" style="display:none;">
    <div class="field"><b>Row:</b> <span id="rowNum"></span></div>
    <div class="field"><b>Customer:</b> <span id="custName"></span></div>
    <div class="field"><b>Product:</b> <span id="prodName"></span></div>
    <div class="field"><b>Internal Warranty #:</b> <span id="iwNum">(blank)</span></div>
    <hr/>
    <label>Intake Stage</label>
    <select id="intakeStage">
      <option value=""></option>
      <option>Not Started</option>
      <option>In Intake</option>
      <option>Intake Complete</option>
    </select>
    <button class="primary" onclick="save()" style="width:100%;margin-top:12px;">Save Intake Stage</button>
    <div id="msg" style="margin-top:8px;"></div>
  </div>
</div>

<script>
let currentRow = null;
async function lookup() {
  const order = document.getElementById("order").value.trim();
  if (!order) return alert("Enter an order number.");
  const r = await fetch("/internal/api/phase2", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "lookup", originalOrderNumber: order })
  });
  const data = await r.json();
  if (data.status === "not_found") return alert("No match found.");
  if (data.status === "multiple") return alert("Multiple matches found.");
  if (data.status !== "ok") return alert("Error: " + (data.message || "Unknown"));
  const match = data.matches[0];
  currentRow = match.row;
  document.getElementById("result").style.display = "block";
  document.getElementById("rowNum").innerText = match.row;
  document.getElementById("custName").innerText = match.customerName || "";
  document.getElementById("prodName").innerText = match.product || "";
  document.getElementById("iwNum").innerText = match.internalWarrantyNumber || "(blank)";
  document.getElementById("intakeStage").value = match.intakeStage || "";
  document.getElementById("msg").innerHTML = "";
}
async function save() {
  if (!currentRow) return alert("Lookup a claim first.");
  const intakeStage = document.getElementById("intakeStage").value;
  const r1 = await fetch("/internal/api/phase2", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update", row: currentRow, updates: { "Intake Stage": intakeStage } })
  });
  const data1 = await r1.json();
  if (data1.status !== "ok") {
    document.getElementById("msg").innerHTML = "<p class='err'>Error: " + (data1.message || "Unknown") + "</p>";
    return;
  }
  const r2 = await fetch("/internal/api/phase2", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "assignInternalWarranty", row: currentRow })
  });
  const data2 = await r2.json();
  if (data2.status === "ok" && data2.internalWarrantyNumber) {
    document.getElementById("iwNum").innerText = data2.internalWarrantyNumber;
  }
  document.getElementById("msg").innerHTML = "<p class='ok'>Saved ✅</p>";
}
</script>
</body>
</html>`);
});

/************************************************************
 * INTERNAL PAGES: PRODUCTION
 ************************************************************/
app.get("/internal/production", requireInternal, (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>RepairFlow – Production</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f4f5f7; }
    .page { max-width: 700px; margin: 32px auto; background: #fff; padding: 28px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h2 { font-size: 1.3rem; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; }
    .sub { color: #888; font-size: 0.8rem; margin-bottom: 20px; }
    label { font-weight: 600; display:block; margin-top:12px; font-size:0.85rem; }
    input, select { width:100%; padding:10px; margin-top:4px; border:1px solid #ddd; border-radius:6px; font-size:0.9rem; }
    button.primary { background:#0b8457; color:#fff; border:none; padding:10px 16px; border-radius:6px; cursor:pointer; font-weight:600; margin-top:8px; }
    button.primary:hover { background:#096e47; }
    .result { border:1px solid #e0e0e0; padding:16px; border-radius:8px; margin-top:20px; }
    .field { margin-bottom:8px; font-size:0.9rem; }
    .ok { color: #0b8457; font-weight:600; }
    .err { color: #dc2626; font-weight:600; }
    hr { border:none; border-top:1px solid #eee; margin:16px 0; }
  </style>
</head>
<body>
${navBar("Production")}
<div class="page">
  <h2>Production</h2>
  <p class="sub">Lookup by Original Order # → Update Production details</p>

  <label>Original Order #</label>
  <div style="display:flex;gap:8px;margin-top:4px;">
    <input id="order" placeholder="Enter order number" style="flex:1" />
    <button class="primary" onclick="lookup()">Lookup</button>
  </div>

  <div id="result" class="result" style="display:none;">
    <div class="field"><b>Row:</b> <span id="rowNum"></span></div>
    <div class="field"><b>Customer:</b> <span id="custName"></span></div>
    <div class="field"><b>Product:</b> <span id="prodName"></span></div>
    <div class="field"><b>Internal Warranty #:</b> <span id="iwNum">(blank)</span></div>
    <hr/>
    <label>Intake Stage</label>
    <select id="intakeStage">
      <option value=""></option>
      <option>Not Started</option>
      <option>In Intake</option>
      <option>Intake Complete</option>
    </select>
    <label>Date Received</label>
    <input type="date" id="dateReceived">
    <label>New Order #</label>
    <input type="text" id="newOrderNumber">
    <label>New Warranty #</label>
    <input type="text" id="newWarrantyNumber">
    <label>Technician Assigned</label>
    <select id="technicianAssigned">
      <option value=""></option>
      <option>Alex Martinez</option>
      <option>Jordan Lee</option>
      <option>Sam Patel</option>
      <option>Chris Nguyen</option>
    </select>
    <button class="primary" onclick="save()" style="width:100%;margin-top:12px;">Save</button>
    <div id="msg" style="margin-top:8px;"></div>
  </div>
</div>

<script>
let currentRow = null;
async function lookup() {
  const order = document.getElementById("order").value.trim();
  if (!order) return alert("Enter an order number.");
  const r = await fetch("/internal/api/phase2", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "lookup", originalOrderNumber: order })
  });
  const data = await r.json();
  if (data.status === "not_found") return alert("No match found.");
  if (data.status === "multiple") return alert("Multiple matches found.");
  if (data.status !== "ok") return alert("Error: " + (data.message || "Unknown"));
  const match = data.matches[0];
  currentRow = match.row;
  document.getElementById("result").style.display = "block";
  document.getElementById("rowNum").innerText = match.row;
  document.getElementById("custName").innerText = match.customerName || "";
  document.getElementById("prodName").innerText = match.product || "";
  document.getElementById("iwNum").innerText = match.internalWarrantyNumber || "(blank)";
  document.getElementById("intakeStage").value = match.intakeStage || "";
  document.getElementById("msg").innerHTML = "";
}
async function save() {
  if (!currentRow) return alert("Lookup a claim first.");
  const r = await fetch("/internal/api/phase2", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update", row: currentRow,
      updates: {
        "Intake Stage": document.getElementById("intakeStage").value,
        "Date Received": document.getElementById("dateReceived").value,
        "New Order #": document.getElementById("newOrderNumber").value,
        "New Warranty #": document.getElementById("newWarrantyNumber").value,
        "Technician Assigned": document.getElementById("technicianAssigned").value
      }
    })
  });
  const data = await r.json();
  document.getElementById("msg").innerHTML = (data.status === "ok")
    ? "<p class='ok'>Saved ✅</p>"
    : "<p class='err'>Error: " + (data.message || "Unknown") + "</p>";
}
</script>
</body>
</html>`);
});

/************************************************************
 * INTERNAL PAGE: QC
 ************************************************************/
app.get("/internal/qc", requireInternal, (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>RepairFlow – QC</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f4f5f7; }
    .page { max-width: 700px; margin: 32px auto; background: #fff; padding: 28px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h2 { font-size: 1.3rem; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; }
    .sub { color: #888; font-size: 0.8rem; margin-bottom: 20px; }
    label { font-weight: 600; display:block; margin-top:12px; font-size:0.85rem; }
    input, select, textarea { width:100%; padding:10px; margin-top:4px; border:1px solid #ddd; border-radius:6px; font-size:0.9rem; }
    textarea { min-height: 90px; resize: vertical; }
    button.primary { background:#0b8457; color:#fff; border:none; padding:10px 16px; border-radius:6px; cursor:pointer; font-weight:600; margin-top:8px; }
    button.primary:hover { background:#096e47; }
    .result { border:1px solid #e0e0e0; padding:16px; border-radius:8px; margin-top:20px; }
    .field { margin-bottom:8px; font-size:0.9rem; }
    .ok { color: #0b8457; font-weight:600; }
    .err { color: #dc2626; font-weight:600; }
    hr { border:none; border-top:1px solid #eee; margin:16px 0; }
  </style>
</head>
<body>
${navBar("QC")}
<div class="page">
  <h2>Quality Control</h2>
  <p class="sub">Lookup by Original Order # → Update QC Result / Reason / Notes</p>

  <label>Original Order #</label>
  <div style="display:flex;gap:8px;margin-top:4px;">
    <input id="order" placeholder="Enter order number" style="flex:1" />
    <button class="primary" onclick="lookup()">Lookup</button>
  </div>

  <div id="result" class="result" style="display:none;">
    <div class="field"><b>Row:</b> <span id="rowNum"></span></div>
    <div class="field"><b>Customer:</b> <span id="custName"></span></div>
    <div class="field"><b>Product:</b> <span id="prodName"></span></div>
    <hr/>
    <label>QC Result</label>
    <select id="qcResult">
      <option value="">(blank)</option>
      <option>Pass</option>
      <option>Fail</option>
    </select>
    <label>QC Reason Code</label>
    <select id="qcReasonCode"><option value="">Loading…</option></select>
    <label>QC Failure Notes</label>
    <textarea id="qcFailureNotes" placeholder="What failed and why?"></textarea>
    <button class="primary" onclick="save()" style="width:100%;margin-top:12px;">Save QC</button>
    <div id="msg" style="margin-top:8px;"></div>
  </div>
</div>

<script>
let currentRow = null;
async function loadReasons(selected = "") {
  const dropdown = document.getElementById("qcReasonCode");
  dropdown.innerHTML = "<option value=''>Loading…</option>";
  const r = await fetch("/internal/api/phase2", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "qcreasons" })
  });
  const data = await r.json();
  dropdown.innerHTML = "<option value=''></option>";
  if (data.status !== "ok") { dropdown.innerHTML = "<option value=''>ERROR</option>"; return; }
  (data.reasons || []).forEach(reason => {
    const opt = document.createElement("option");
    opt.value = reason; opt.textContent = reason;
    dropdown.appendChild(opt);
  });
  dropdown.value = selected || "";
}
async function lookup() {
  const order = document.getElementById("order").value.trim();
  if (!order) return alert("Enter an order number.");
  const r = await fetch("/internal/api/phase2", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "lookup", originalOrderNumber: order })
  });
  const data = await r.json();
  if (data.status === "not_found") return alert("No match found.");
  if (data.status === "multiple") return alert("Multiple matches found.");
  if (data.status !== "ok") return alert("Error: " + (data.message || "Unknown"));
  const match = data.matches[0];
  currentRow = match.row;
  document.getElementById("result").style.display = "block";
  document.getElementById("rowNum").innerText = match.row;
  document.getElementById("custName").innerText = match.customerName || "";
  document.getElementById("prodName").innerText = match.product || "";
  document.getElementById("qcResult").value = match.qcResult || "";
  document.getElementById("qcFailureNotes").value = match.qcFailureNotes || "";
  await loadReasons(match.qcReasonCode || "");
  document.getElementById("msg").innerHTML = "";
}
async function save() {
  if (!currentRow) return alert("Lookup a claim first.");
  const r = await fetch("/internal/api/phase2", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update", row: currentRow,
      updates: {
        "QC Result": document.getElementById("qcResult").value,
        "QC Reason Code": document.getElementById("qcReasonCode").value,
        "QC Failure Notes": document.getElementById("qcFailureNotes").value.trim()
      }
    })
  });
  const data = await r.json();
  document.getElementById("msg").innerHTML = (data.status === "ok")
    ? "<p class='ok'>Saved ✅</p>"
    : "<p class='err'>Error: " + (data.message || "Unknown") + "</p>";
}
</script>
</body>
</html>`);
});

/************************************************************
 * ANALYTICS DASHBOARD (public — demo data only)
 ************************************************************/
app.get("/internal/analytics", (req, res) => {
  res.sendFile(__dirname + "/Public/analytics.html");
});

/************************************************************
 * SERVER START
 ************************************************************/
app.listen(PORT, () => {
  console.log("🚀 RepairFlow Warranty API running on port", PORT);
});
