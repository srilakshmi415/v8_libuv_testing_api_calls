/*
 * server.js -- OTA server with remote upload
 *
 *   node server.js
 *
 * Open http://localhost:8080/ in a browser to paste code and deploy it.
 * Anyone who can reach this address can do the same, from anywhere.
 *
 * APIs the dongle uses:
 *   GET /api/checkflag   what should I do
 *   GET /api/getcode     give me the code
 *
 * For a person uploading:
 *   GET  /                the page
 *   POST /admin/upload    send new code        (needs the token)
 *   GET  /admin/setflag   set the flag by hand (needs the token)
 *   GET  /admin/status    what the server thinks
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT  = process.env.PORT || 8080;
const TOKEN = process.env.OTA_TOKEN || "change-this-token";
const STORE = path.join(__dirname, "current_app.js");

// ------------------------------------------------------------------
let FLAG    = 0;
let VERSION = "1.0.0";
let CODE    = 'console.log("=== nothing uploaded yet ===");\n';

// keep the last upload across restarts
if (fs.existsSync(STORE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(STORE, "utf8"));
        CODE    = saved.code;
        VERSION = saved.version;
        console.log("loaded saved code, version " + VERSION);
    } catch (e) { }
}

function save() {
    try { fs.writeFileSync(STORE, JSON.stringify({ code: CODE, version: VERSION })); }
    catch (e) { log("could not save: " + e); }
}

const devices = {};

function log(m) {
    console.log("[" + new Date().toISOString().substring(11, 19) + "] " + m);
}

function params(url) {
    const p = {}, i = url.indexOf("?");
    if (i < 0) return p;
    url.substring(i + 1).split("&").forEach(function (pair) {
        const eq = pair.indexOf("=");
        if (eq > 0) p[pair.substring(0, eq)] = decodeURIComponent(pair.substring(eq + 1));
    });
    return p;
}

function json(res, obj, code) {
    const b = JSON.stringify(obj);
    res.writeHead(code || 200, { "Content-Type": "application/json",
                                 "Content-Length": Buffer.byteLength(b) });
    res.end(b);
}

function text(res, t) {
    res.writeHead(200, { "Content-Type": "text/plain",
                         "Content-Length": Buffer.byteLength(t) });
    res.end(t);
}

// anyone can read; only the token can change anything
function authorised(req, p) {
    const h = req.headers["x-ota-token"];
    return (h === TOKEN) || (p.token === TOKEN);
}

// ------------------------------------------------------------------
//  the two APIs the dongle calls
// ------------------------------------------------------------------
function checkflag(res, p) {
    const device  = p.device  || "unknown";
    const running = p.version || "0";
    if (!devices[device]) devices[device] = { staged: null };

    if (p.ack) {
        log(device + " confirmed " + p.ack);
        devices[device].running  = p.ack;
        devices[device].lastSeen = new Date().toISOString();
        if (p.ack === VERSION) { FLAG = 0; log("flag reset to 0"); }
        return json(res, { ok: true });
    }

    devices[device].running  = running;
    devices[device].lastSeen = new Date().toISOString();

    let flag = FLAG;
    if (running === VERSION) flag = 0;
    else if (FLAG === 2 && devices[device].staged !== VERSION) {
        log(device + " never downloaded, sending flag 1 instead");
        flag = 1;
    }

    log(device + " running=" + running + " -> flag=" + flag);
    json(res, { flag: flag, version: VERSION, size: Buffer.byteLength(CODE) });
}

function getcode(res, p) {
    const device = p.device || "unknown";
    devices[device] = devices[device] || {};
    devices[device].staged = VERSION;
    log(device + " downloaded " + Buffer.byteLength(CODE) + " bytes");
    text(res, CODE);
}

// ------------------------------------------------------------------
//  upload - this is what lets someone elsewhere deploy
// ------------------------------------------------------------------
function upload(req, res, p) {
    if (!authorised(req, p)) return json(res, { error: "bad token" }, 401);

    let body = "";
    req.on("data", function (c) {
        body += c;
        if (body.length > 1024 * 1024) req.destroy();   // 1 MB cap
    });

    req.on("end", function () {
        let newCode = body, newVersion = null, autoDeploy = false;

        // accept either raw code, or JSON with a version
        try {
            const o = JSON.parse(body);
            if (o && typeof o.code === "string") {
                newCode    = o.code;
                newVersion = o.version || null;
                autoDeploy = !!o.deploy;
            }
        } catch (e) { }

        if (!newCode || !newCode.length) return json(res, { error: "no code" }, 400);

        CODE    = newCode;
        VERSION = newVersion || bumpVersion(VERSION);
        FLAG    = autoDeploy ? 1 : 0;
        save();

        log("UPLOAD " + Buffer.byteLength(CODE) + " bytes, version " + VERSION +
            (autoDeploy ? ", deploying" : ", not deployed yet"));

        json(res, { ok: true, version: VERSION,
                    size: Buffer.byteLength(CODE), flag: FLAG });
    });
}

function bumpVersion(v) {
    const bits = ("" + v).split(".");
    const last = parseInt(bits[bits.length - 1], 10);
    if (isNaN(last)) return "1.0.1";
    bits[bits.length - 1] = "" + (last + 1);
    return bits.join(".");
}

function setflag(req, res, p) {
    if (!authorised(req, p)) return json(res, { error: "bad token" }, 401);
    FLAG = parseInt(p.flag, 10) || 0;
    if (p.version) VERSION = p.version;
    log("ADMIN flag=" + FLAG + " version=" + VERSION);
    json(res, { ok: true, flag: FLAG, version: VERSION });
}

function status(res) {
    json(res, { flag: FLAG, version: VERSION,
                codeSize: Buffer.byteLength(CODE), devices: devices });
}

// ------------------------------------------------------------------
//  the page
// ------------------------------------------------------------------
function page(res) {
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dongle OTA</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#222}
 h1{font-size:22px} h2{font-size:16px;margin-top:28px}
 textarea{width:100%;height:260px;font-family:ui-monospace,Consolas,monospace;font-size:13px;
          padding:10px;border:1px solid #ccc;border-radius:6px}
 input{padding:8px;border:1px solid #ccc;border-radius:6px;font-size:14px}
 button{padding:9px 16px;border:0;border-radius:6px;background:#1a5fb4;color:#fff;
        font-size:14px;cursor:pointer;margin-right:8px}
 button.plain{background:#555}
 pre{background:#f4f4f4;padding:12px;border-radius:6px;font-size:12px;overflow:auto}
 .row{margin:12px 0}
 .msg{padding:10px;border-radius:6px;margin:12px 0;display:none}
 .ok{background:#d7f5dd} .err{background:#ffd9d9}
</style></head><body>
<h1>Dongle OTA</h1>
<p>Paste the JavaScript to send to the device, then deploy it.</p>

<div class="row"><input id="token" type="password" placeholder="token" size="30"></div>
<textarea id="code" placeholder="console.log('hello from over the air');"></textarea>
<div class="row">
  <input id="version" placeholder="version, optional" size="16">
  <button onclick="upload(true)">Upload and deploy</button>
  <button class="plain" onclick="upload(false)">Upload only</button>
  <button class="plain" onclick="setflag(2)">Apply staged</button>
  <button class="plain" onclick="refresh()">Refresh</button>
</div>
<div id="msg" class="msg"></div>

<h2>Server status</h2>
<pre id="status">loading...</pre>

<script>
function show(t, good){
  var m=document.getElementById('msg');
  m.textContent=t; m.className='msg '+(good?'ok':'err'); m.style.display='block';
}
function upload(deploy){
  var tok=document.getElementById('token').value;
  var code=document.getElementById('code').value;
  var ver=document.getElementById('version').value;
  if(!code.trim()) return show('nothing to upload', false);
  fetch('/admin/upload',{method:'POST',headers:{'x-ota-token':tok},
    body:JSON.stringify({code:code, version:ver||null, deploy:deploy})})
   .then(function(r){return r.json();})
   .then(function(d){
      if(d.error) show(d.error,false);
      else show('uploaded '+d.size+' bytes as version '+d.version+
                (deploy?' - devices will download on the next poll':' - not deployed'),true);
      refresh();
   }).catch(function(e){show(''+e,false);});
}
function setflag(f){
  var tok=document.getElementById('token').value;
  fetch('/admin/setflag?flag='+f+'&token='+encodeURIComponent(tok))
   .then(function(r){return r.json();})
   .then(function(d){ show(d.error? d.error : 'flag set to '+d.flag, !d.error); refresh(); });
}
function refresh(){
  fetch('/admin/status').then(function(r){return r.json();})
   .then(function(d){ document.getElementById('status').textContent=
                      JSON.stringify(d,null,2); });
}
refresh(); setInterval(refresh, 5000);
</script>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html",
                         "Content-Length": Buffer.byteLength(html) });
    res.end(html);
}

// ------------------------------------------------------------------
http.createServer(function (req, res) {
    const p = params(req.url);
    const route = req.url.split("?")[0];

    if      (route === "/")               page(res);
    else if (route === "/api/checkflag")   checkflag(res, p);
    else if (route === "/api/getcode")     getcode(res, p);
    else if (route === "/admin/upload")    upload(req, res, p);
    else if (route === "/admin/setflag")   setflag(req, res, p);
    else if (route === "/admin/status")    status(res);
    else { res.writeHead(404); res.end(); }
}).listen(PORT, "0.0.0.0", function () {
    log("OTA server listening on port " + PORT);
    log("flag=" + FLAG + " version=" + VERSION);
    console.log("");
    console.log("  page:   http://localhost:" + PORT + "/");
    console.log("  token:  " + TOKEN + "   (set OTA_TOKEN to change it)");
    console.log("");
});
