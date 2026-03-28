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
 * DEBUG LOOKUP
 ************************************************************/
app.get("/debug/lookup", async (req, res) => {
  const payload = {
    action: "lookup",
    key: process.env.PHASE2_KEY || "repairflow_phase2_demo",
    originalOrderNumber: "RF-10042"
  };
  const r = await scriptFetch(payload);
  const text = await r.text();
  res.send(`<pre>STATUS: ${r.status}\n\nBODY:\n${text}</pre>`);
});

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
 * DEBUG LOOKUP
 ************************************************************/
app.get("/debug/lookup", async (req, res) => {
  const scriptUrl = process.env.PHASE2_SCRIPT_URL;
  const payload = {
    action: "lookup",
    key: process.env.PHASE2_KEY || "repairflow_phase2_demo",
    originalOrderNumber: "RF-10042"
  };
  const r = await scriptFetch(payload);
  const text = await r.text();
  res.send(`<pre>STATUS: ${r.status}\n\nBODY:\n${text}</pre>`);
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
 * INTERNAL PAGE HTML GENERATOR
 ************************************************************/
function getInternalPageHtml(cfg) {
  const optionHtml = cfg.options.map(v => `<option>${v}</option>`).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${cfg.title}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; max-width: 700px; margin: auto; }
    input, select, button { padding: 10px; margin: 6px 0; width: 100%; }
    .row { border: 1px solid #ddd; padding: 12px; border-radius: 10px; margin-top: 15px; }
    .ok { color: green; }
    .err { color: red; }
    .small { color: #666; font-size: 12px; margin-top: 6px; }
  </style>
</head>
<body>
  <h2>${cfg.title}</h2>
  <p class="small">Lookup by <b>Original Order #</b> → Update <b>${cfg.stageLabel}</b></p>

  <label>Original Order #</label>
  <input id="order" placeholder="Enter order number" />
  <button onclick="lookup()">Lookup</button>

  <div id="result" class="row" style="display:none;">
    <div><b>Row:</b> <span id="rowNum"></span></div>
    <div><b>Status:</b> <span id="status"></span></div>
    <hr/>

    <label>${cfg.stageLabel}</label>
    <select id="${cfg.stageId}">
      ${optionHtml}
    </select>

    <button onclick="save()">${cfg.buttonText}</button>
    <div id="msg"></div>
  </div>

<script>
let currentRow = null;

async function lookup() {
  const order = document.getElementById("order").value.trim();
  if (!order) return alert("Enter an order number.");

  const r = await fetch("/internal/api/phase2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  document.getElementById("status").innerText = match.status || "";
  document.getElementById("${cfg.stageId}").value = match["${cfg.matchField}"] || "";
  document.getElementById("msg").innerHTML = "";
}

async function save() {
  if (!currentRow) return alert("Lookup a claim first.");

  const val = document.getElementById("${cfg.stageId}").value;

  const r = await fetch("/internal/api/phase2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update",
      row: currentRow,
      updates: { "${cfg.updateHeader}": val }
    })
  });

  const data = await r.json();
  const msg = document.getElementById("msg");

  msg.innerHTML = (data.status === "ok")
    ? "<p class='ok'>Saved ✅</p>"
    : "<p class='err'>Error: " + (data.message || "Unknown") + "</p>";
}
</script>
</body>
</html>`;
}

/************************************************************
 * INTERNAL PAGES: INTAKE + PRODUCTION
 ************************************************************/
app.get("/internal/intake", requireInternal, (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>RepairFlow – Receiving Intake</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; max-width: 700px; margin: auto; }
    input, select, button { padding: 10px; margin: 6px 0; width: 100%; }
    .row { border: 1px solid #ddd; padding: 12px; border-radius: 10px; margin-top: 15px; }
    .ok { color: green; }
    .err { color: red; }
    .small { color: #666; font-size: 12px; margin-top: 6px; }
  </style>
</head>
<body>
  <h2>RepairFlow – Receiving Intake</h2>
  <p class="small">Lookup by <b>Original Order #</b> → Update <b>Intake Stage</b> + auto-assign <b>Internal Warranty #</b></p>

  <label>Original Order #</label>
  <input id="order" placeholder="Enter order number" />
  <button onclick="lookup()">Lookup</button>

  <div id="result" class="row" style="display:none;">
    <div><b>Row:</b> <span id="rowNum"></span></div>
    <div><b>Status:</b> <span id="status"></span></div>
    <div><b>Internal Warranty #:</b> <span id="iwNum">(blank)</span></div>
    <hr/>

    <label>Intake Stage</label>
    <select id="intakeStage">
      <option value=""></option>
      <option>Not Started</option>
      <option>In Intake</option>
      <option>Intake Complete</option>
    </select>

    <button onclick="save()">Save Intake Stage</button>
    <div id="msg"></div>
  </div>

<script>
let currentRow = null;

async function lookup() {
  const order = document.getElementById("order").value.trim();
  if (!order) return alert("Enter an order number.");

  const r = await fetch("/internal/api/phase2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  document.getElementById("status").innerText = match.status || "";
  document.getElementById("iwNum").innerText = match.internalWarrantyNumber || "(blank)";
  document.getElementById("intakeStage").value = match.intakeStage || "";
  document.getElementById("msg").innerHTML = "";
}

async function save() {
  if (!currentRow) return alert("Lookup a claim first.");

  const intakeStage = document.getElementById("intakeStage").value;

  const r1 = await fetch("/internal/api/phase2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update",
      row: currentRow,
      updates: { "Intake Stage": intakeStage }
    })
  });

  const data1 = await r1.json();
  if (data1.status !== "ok") {
    document.getElementById("msg").innerHTML =
      "<p class='err'>Error saving Intake Stage: " + (data1.message || "Unknown") + "</p>";
    return;
  }

  const r2 = await fetch("/internal/api/phase2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "assignInternalWarranty",
      row: currentRow
    })
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

app.get("/internal/production", requireInternal, (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>RepairFlow – Production</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; max-width: 700px; margin: auto; }
    input, select, button { padding: 10px; margin: 6px 0; width: 100%; }
    .row { border: 1px solid #ddd; padding: 12px; border-radius: 10px; margin-top: 15px; }
    .ok { color: green; }
    .err { color: red; }
    .small { color: #666; font-size: 12px; margin-top: 6px; }
  </style>
</head>
<body>
  <h2>RepairFlow – Production</h2>
  <p class="small">Lookup by <b>Original Order #</b> → Update <b>Production Stage</b></p>

  <label>Original Order #</label>
  <input id="order" placeholder="Enter order number" />
  <button onclick="lookup()">Lookup</button>

  <div id="result" class="row" style="display:none;">
    <div><b>Row:</b> <span id="rowNum"></span></div>
    <div><b>Status:</b> <span id="status"></span></div>
    <div><b>Internal Warranty #:</b> <span id="iwNum">(blank)</span></div>
    <hr/>

    <label>Intake Stage</label>
    <select id="intakeStage">
      <option value=""></option>
      <option>Not Started</option>
      <option>In Intake</option>
      <option>Intake Complete</option>
    </select>

    <hr/>

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

    <button onclick="save()">Save</button>
    <div id="msg"></div>
  </div>

<script>
let currentRow = null;

async function lookup() {
  const order = document.getElementById("order").value.trim();
  if (!order) return alert("Enter an order number.");

  const r = await fetch("/internal/api/phase2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  document.getElementById("status").innerText = match.status || "";
  document.getElementById("iwNum").innerText = match.internalWarrantyNumber || "(blank)";
  document.getElementById("intakeStage").value = match.intakeStage || "";
  document.getElementById("msg").innerHTML = "";
}

async function save() {
  if (!currentRow) return alert("Lookup a claim first.");

  const r = await fetch("/internal/api/phase2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update",
      row: currentRow,
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
    body { font-family: Arial, sans-serif; padding: 20px; max-width: 750px; margin: auto; }
    input, select, textarea, button { padding: 10px; margin: 6px 0; width: 100%; }
    textarea { min-height: 90px; }
    .row { border: 1px solid #ddd; padding: 12px; border-radius: 10px; margin-top: 15px; }
    .ok { color: green; }
    .err { color: red; }
    .small { color: #666; font-size: 12px; margin-top: 6px; }
  </style>
</head>
<body>
  <h2>RepairFlow – QC</h2>
  <p class="small">Lookup by <b>Original Order #</b> → Update <b>QC Result / Reason / Notes</b></p>

  <label>Original Order #</label>
  <input id="order" placeholder="Enter order number" />
  <button onclick="lookup()">Lookup</button>

  <div id="result" class="row" style="display:none;">
    <div><b>Row:</b> <span id="rowNum"></span></div>
    <div><b>Status:</b> <span id="status"></span></div>
    <hr/>

    <label>QC Result</label>
    <select id="qcResult">
      <option value="">(blank)</option>
      <option>Pass</option>
      <option>Fail</option>
    </select>

    <label>QC Reason Code</label>
    <select id="qcReasonCode">
      <option value="">Loading…</option>
    </select>

    <label>QC Failure Notes</label>
    <textarea id="qcFailureNotes" placeholder="What failed and why?"></textarea>

    <button onclick="save()">Save QC</button>
    <div id="msg"></div>
  </div>

<script>
let currentRow = null;

async function loadReasons(selected = "") {
  const dropdown = document.getElementById("qcReasonCode");
  dropdown.innerHTML = "<option value=''>Loading…</option>";

  const r = await fetch("/internal/api/phase2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "qcreasons" })
  });

  const data = await r.json();
  dropdown.innerHTML = "<option value=''></option>";

  if (data.status !== "ok") {
    dropdown.innerHTML = "<option value=''>ERROR LOADING LIST</option>";
    return;
  }

  (data.reasons || []).forEach(reason => {
    const opt = document.createElement("option");
    opt.value = reason;
    opt.textContent = reason;
    dropdown.appendChild(opt);
  });

  dropdown.value = selected || "";
}

async function lookup() {
  const order = document.getElementById("order").value.trim();
  if (!order) return alert("Enter an order number.");

  const r = await fetch("/internal/api/phase2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  document.getElementById("status").innerText = match.status || "";
  document.getElementById("qcResult").value = match.qcResult || "";
  document.getElementById("qcFailureNotes").value = match.qcFailureNotes || "";

  await loadReasons(match.qcReasonCode || "");
  document.getElementById("msg").innerHTML = "";
}

async function save() {
  if (!currentRow) return alert("Lookup a claim first.");

  const r = await fetch("/internal/api/phase2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update",
      row: currentRow,
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
 * SERVER START
 ************************************************************/
app.listen(PORT, () => {
  console.log("🚀 RepairFlow Warranty API running on port", PORT);
});
