import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/?$/, "/");
const read = (rel) => readFileSync(root + rel);
const VITARMIS_URL = "https://thespartancapitalgroup.com/wp-content/uploads/2026/11/vitarmis-horizontal.png";
const EM = "\u2014";

const ASSET_SHA256 = {
  "assets/apple-touch-icon.png": "b22ed1692b2a0cf28e74c431f2a9c266f776f4aa30c40e80fa08510945d6163b",
  "assets/favicon-32.png": "f0ded25d69a5992a5673f86e94697abc8f662f5563933cf0a43e50fd19bf5bb8",
  "assets/scg-logo.svg": "0ac8736c7e3c11e88e5c5419b01667bcf2c7cdbc9c5154c03cfada4d30160efc",
  "assets/spartan-advisory-solutions-signature-logo-2x.png": "a68d332d784bd4d99f7a87459ad3426fa17d7299aa8142e343e9489e3ca723d5",
  "assets/spartan-capital-group-signature-logo-2x.png": "08cdf4d92d46a9b82886be754c59cbeeeb53f3e35181c0fa30cff07282a966fa",
  "assets/spartan-strategies-signature-logo-2x.png": "e8c4f53bb62f7f7ac689321b65f75cd8cc6ceb4604c444af6969d3f535046833",
  "assets/vitarmis-signature-logo-2x.png": "ac73a39212659c78ae61cf20c175f2c5c47489c2965a0a5b483176a62a7f821f",
  "email/talent-advantage/banner@2x.png": "0a89610e2eca461adb4338cc13277169914a209304055a7eb9b0e5408e8d5c1b",
  "email/talent-advantage/scg-logo.png": "08cdf4d92d46a9b82886be754c59cbeeeb53f3e35181c0fa30cff07282a966fa",
};

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function pngSize(buf) {
  if (buf.toString("ascii", 1, 4) !== "PNG") throw new Error("not a png");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function assertEqual(actual, expected, label) {
  if (actual === expected) return;
  let i = 0;
  const n = Math.min(actual.length, expected.length);
  while (i < n && actual[i] === expected[i]) i++;
  throw new Error(
    label + " mismatch at " + i + " (actual " + actual.length + ", expected " + expected.length + ")\n" +
    "actual:   " + JSON.stringify(actual.slice(Math.max(0, i - 70), i + 90)) + "\n" +
    "expected: " + JSON.stringify(expected.slice(Math.max(0, i - 70), i + 90))
  );
}

function checkAssets() {
  for (const [rel, hex] of Object.entries(ASSET_SHA256)) {
    const got = sha256(read(rel));
    if (got !== hex) throw new Error(rel + " hash changed: " + got);
  }
  const size = pngSize(read("assets/vitarmis-signature-logo-2x.png"));
  if (size.width !== 416 || size.height !== 120) throw new Error("Vitarmis logo is " + size.width + "x" + size.height);
  const page = read("index.html").toString("utf8");
  if (page.includes("\u2014") || page.includes("\u2013")) throw new Error("index.html contains a dash that is not a hyphen");
  if (!page.includes(VITARMIS_URL)) throw new Error("family row is missing the approved Vitarmis logo");
  if (!page.includes("assets/vitarmis-signature-logo-2x.png")) throw new Error("brand picker lost the local Vitarmis asset");
}

function startServer() {
  const types = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith("/")) p += "index.html";
      const data = read(p.slice(1));
      res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream" });
      res.end(data);
    } catch (e) {
      res.writeHead(404);
      res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function withPage(server, fn) {
  const port = server.address().port;
  const profile = "/tmp/sig-test-chrome-" + process.pid;
  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--no-first-run", "--disable-extensions", "--remote-debugging-port=0",
    "--user-data-dir=" + profile, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let dbg = "";
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Chrome did not open a DevTools port\n" + dbg)), 15000);
      chrome.stderr.on("data", (d) => {
        dbg += d;
        const m = dbg.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map();
    const queue = [];
    const waiting = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); return; }
      if (!msg.method) return;
      const slot = waiting.findIndex((w) => w.pred(msg));
      if (slot >= 0) waiting.splice(slot, 1)[0].resolve(msg);
      else queue.push(msg);
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (msg) => {
        pending.delete(id);
        if (msg.error) reject(new Error(method + " " + JSON.stringify(msg.error)));
        else resolve(msg.result);
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
    const waitEvent = (pred, timeout = 10000) => {
      const idx = queue.findIndex(pred);
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for a browser event")), timeout);
        waiting.push({ pred, resolve: (msg) => { clearTimeout(t); resolve(msg); } });
      });
    };
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Page.navigate", { url: "http://127.0.0.1:" + port + "/index.html" });
    await waitEvent((m) => m.method === "Page.loadEventFired");
    const evaljs = async (expression) => {
      const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await fn({ port, call, evaljs, waitEvent, sessionId });
    ws.close();
  } finally {
    chrome.kill();
  }
}

async function fill(evaljs, fields, brand) {
  await evaljs(`(() => {
    const set = (id, value) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("name", ${JSON.stringify(fields.name)});
    set("title", ${JSON.stringify(fields.title)});
    set("email", ${JSON.stringify(fields.email)});
    set("direct", ${JSON.stringify(fields.direct)});
    set("mobile", ${JSON.stringify(fields.mobile)});
    const radio = document.querySelector(${JSON.stringify('input[name=brand][value="' + brand + '"]')});
    if (!radio) throw new Error("missing brand");
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

function norm(html, port) {
  return html.split("http://127.0.0.1:" + port).join("http://ORIGIN");
}

async function main() {
  checkAssets();
  const fixtures = JSON.parse(read("tests/fixtures/single-brand.json").toString("utf8"));
  const kurtisHtml = read("tests/fixtures/kurtis-family.html").toString("utf8");
  const server = await startServer();
  try {
    await withPage(server, async ({ port, evaljs }) => {
      const brands = await evaljs(`(() => [...document.querySelectorAll('input[name=brand]')].map(el => ({
        value: el.value,
        label: el.closest("label").innerText.replace(/\\s+/g, " ").trim(),
        checked: el.checked
      })))()`);
      if (brands.map((b) => b.value).join(",") !== "scg,sas,ss,family") {
        throw new Error("brand options changed: " + JSON.stringify(brands));
      }
      if (brands[0].checked !== true) throw new Error("Spartan Capital Group is no longer the default");
      if (brands[3].label !== "Family of companies") throw new Error("family label: " + brands[3].label);
      for (const fx of fixtures) {
        await fill(evaljs, fx, fx.brand);
        const html = norm(await evaljs("build()"), port);
        const plain = await evaljs("plain()");
        assertEqual(html, fx.html, fx.brand + " html");
        assertEqual(plain, fx.plain, fx.brand + " plain");
        if (html.includes("FAMILY OF COMPANIES") || html.includes("vitarmis")) {
          throw new Error(fx.brand + " output picked up the family row");
        }
        if (!html.includes(">thespartancapitalgroup.com</a>")) throw new Error(fx.brand + " lost the website line");
        const preview = await evaljs("document.getElementById('sig').innerText");
        if (preview.includes("FAMILY OF COMPANIES")) throw new Error(fx.brand + " preview shows the family row");
      }
      const kurtis = {
        name: "Kurtis Hine, Sr.",
        title: "Founder & CEO",
        email: "kurtis.hine@thespartancapitalgroup.com",
        direct: "248-525-4050",
        mobile: "",
      };
      await fill(evaljs, kurtis, "family");
      const familyHtml = await evaljs("build()");
      const familyPlain = await evaljs("plain()");
      assertEqual(familyHtml, kurtisHtml, "family html");
      if (familyHtml.includes("text-align:center") || familyHtml.includes("margin:0 auto")) {
        throw new Error("family signature is still centered");
      }
      if (!/^<table\b[^>]*\balign="left"/.test(familyHtml)) throw new Error("family table is missing align=left");
      if (/font-weight:normal;">(?:&nbsp;|<span style="font-size:14\.4px)/.test(familyHtml)) {
        throw new Error("family line has a leading indent");
      }
      assertEqual(familyPlain, [
        "Kurtis Hine, Sr. | Founder & CEO",
        "Spartan Capital Group",
        "D 248-525-4050 | Toll-free 800-340-9118",
        "kurtis.hine@thespartancapitalgroup.com",
        "Family of companies: Spartan Capital Group, Vitarmis, Spartan Advisory Solutions, Spartan Strategies",
      ].join("\n"), "family plain");
      if (familyHtml.length >= 10000) throw new Error("Kurtis family signature is " + familyHtml.length + " characters");
      if (familyHtml.includes(EM) || familyPlain.includes(EM)) throw new Error("family copy contains an em dash");
      if (familyPlain.split("\n").includes("thespartancapitalgroup.com")) throw new Error("family plain text still has a website line");
      if (familyHtml.includes(">thespartancapitalgroup.com</a>")) throw new Error("family html still has a website line");
      const imgs = await evaljs(`(() => [...build().matchAll(/<img\\b[^>]*>/g)].map(m => m[0]))()`);
      const srcOf = (tag) => tag.match(/src="([^"]+)"/)[1];
      const whOf = (tag) => [tag.match(/width="(\d+)"/)[1], tag.match(/height="(\d+)"/)[1]].join("x");
      const expectedImgs = [
        ["https://kurtishine-afk.github.io/scg-signature/assets/spartan-capital-group-signature-logo-2x.png", "208x60"],
        ["https://kurtishine-afk.github.io/scg-signature/assets/spartan-capital-group-signature-logo-2x.png", "70x20"],
        [VITARMIS_URL, "87x19"],
        ["https://kurtishine-afk.github.io/scg-signature/assets/spartan-advisory-solutions-signature-logo-2x.png", "70x20"],
        ["https://kurtishine-afk.github.io/scg-signature/assets/spartan-strategies-signature-logo-2x.png", "70x20"],
      ];
      if (imgs.length !== expectedImgs.length) throw new Error("image count " + imgs.length);
      expectedImgs.forEach((exp, i) => {
        if (srcOf(imgs[i]) !== exp[0] || whOf(imgs[i]) !== exp[1]) {
          throw new Error("image " + i + " is " + srcOf(imgs[i]) + " " + whOf(imgs[i]));
        }
      });
      const hrefs = await evaljs(`(() => [...build().matchAll(/<a\\b[^>]*href="([^"]+)"/g)].map(m => m[1]))()`);
      const expectedHrefs = [
        "https://www.thespartancapitalgroup.com",
        "tel:+1-248-525-4050",
        "tel:+1-800-340-9118",
        "mailto:kurtis.hine@thespartancapitalgroup.com",
        "https://www.thespartancapitalgroup.com",
        "https://vitarmis.com/",
        "https://www.thespartancapitalgroup.com/about-us/",
        "https://www.thespartancapitalgroup.com/about-us/",
      ];
      assertEqual(hrefs.join("\n"), expectedHrefs.join("\n"), "family links");
      const preview = await evaljs("document.getElementById('sig').innerText");
      for (const bit of ["Kurtis Hine, Sr.", "Founder & CEO", "PLACING PEOPLE FIRST", "FAMILY OF COMPANIES", "7550 S. Saginaw, Grand Blanc, MI 48439"]) {
        if (!preview.includes(bit)) throw new Error("preview missing " + bit);
      }
      if (preview.split("\n").map((line) => line.trim()).includes("thespartancapitalgroup.com")) {
        throw new Error("preview shows a website line");
      }

      await fill(evaljs, {
        name: "Tom & <Jen>",
        title: 'VP "East"',
        email: "tom.jen@thespartancapitalgroup.com",
        direct: "",
        mobile: "3135550199",
      }, "family");
      const escaped = await evaljs("build()");
      if (!escaped.includes("Tom &amp; &lt;Jen&gt;")) throw new Error("name was not escaped");
      if (!escaped.includes("VP &quot;East&quot;")) throw new Error("title was not escaped");
      if (escaped.includes("text-align:center") || /font-weight:normal;">(?:&nbsp;|<span style="font-size:14\.4px)/.test(escaped)) {
        throw new Error("optional phone line is indented or centered");
      }
      if (escaped.includes(">DIRECT<")) throw new Error("empty direct line was kept");
      if (!escaped.includes(">MOBILE<") || !escaped.includes("313-555-0199")) throw new Error("mobile line missing");
      if (escaped.length >= 10000) throw new Error("family signature with mobile is " + escaped.length);
      const escapedPlain = await evaljs("plain()");
      if (!escapedPlain.includes("Tom & <Jen> | VP \"East\"")) throw new Error("plain text lost characters: " + escapedPlain);
      if (!escapedPlain.includes("M 313-555-0199 | Toll-free 800-340-9118")) throw new Error("plain phones: " + escapedPlain);
      if (escapedPlain.includes(EM)) throw new Error("plain text contains an em dash");

      const longHtml = await evaljs(`(() => {
        document.getElementById('name').value = ${JSON.stringify("Jordan".repeat(12))};
        document.getElementById('title').value = ${JSON.stringify("Partner".repeat(10))};
        document.getElementById('email').value = ${JSON.stringify("jordan.example.with.a.long.mailbox@thespartancapitalgroup.com")};
        document.getElementById('direct').value = "2485550100";
        document.getElementById('mobile').value = "3135550199";
        render();
        return build();
      })()`);
      if (longHtml.length >= 10000) throw new Error("long family signature is " + longHtml.length + " characters");

      const again = fixtures[0];
      await fill(evaljs, again, "scg");
      assertEqual(norm(await evaljs("build()"), port), again.html, "scg html after leaving family");
      assertEqual(await evaljs("plain()"), again.plain, "scg plain after leaving family");
    });
  } finally {
    server.close();
  }
  console.log("signature tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
