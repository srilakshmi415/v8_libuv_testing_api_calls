/*
 * server.js -- OTA server for the N75 dongle
 *
 * Run on your server laptop with real Node.js:
 *     node server.js
 *
 * Two APIs:
 *   API 1:  GET /api/checkflag   -> returns the flag
 *   API 2:  GET /api/getcode     -> returns the new JavaScript code
 *
 * Flags:
 *   0 = dongle is up to date, do nothing
 *   1 = new code available, dongle should download it
 *   2 = dongle should apply the downloaded code and restart
 */

const http = require('http');

const PORT = 8080;

// ==================================================================
// STATE -- change FLAG and VERSION to control the update
// ==================================================================
let FLAG    = 0;
let VERSION = "1.0.0";

// The code that gets sent to the dongle when FLAG is 1.
// Edit this string, bump VERSION, set FLAG = 1.
let CODE =
    'console.log("=== app v1.0.0 running ===");\n' +
    'var n = 0;\n' +
    'setInterval(function () {\n' +
    '    n = n + 1;\n' +
    '    console.log("heartbeat " + n);\n' +
    '}, 5000);\n';

// remember what each dongle has done
const devices = {};

// ==================================================================
function log(msg) {
    console.log("[" + new Date().toISOString().substring(11, 19) + "] " + msg);
}

// pull ?device=x&version=y into an object
function getParams(url) {
    const p = {};
    const i = url.indexOf("?");
    if (i < 0) return p;
    url.substring(i + 1).split("&").forEach(function (pair) {
        const eq = pair.indexOf("=");
        if (eq > 0) {
            p[pair.substring(0, eq)] = decodeURIComponent(pair.substring(eq + 1));
        }
    });
    return p;
}

function sendJSON(res, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
    });
    res.end(body);
}

function sendText(res, text) {
    res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(text)
    });
    res.end(text);
}

// ==================================================================
// API 1 -- the dongle polls this every minute
//
//   GET /api/checkflag?device=N75-0001&version=1.0.0
//   GET /api/checkflag?device=N75-0001&ack=1.0.1
// ==================================================================
function api1_checkflag(res, p) {
    const device  = p.device  || "unknown";
    const running = p.version || "0";

    if (!devices[device]) devices[device] = { staged: null };

    // --- the dongle is telling us it finished applying an update ---
    if (p.ack) {
        log(device + " confirmed version " + p.ack);
        devices[device].running = p.ack;

        // Reset the flag, otherwise the dongle would update forever
        // in a loop, applying the same version again and again.
        if (p.ack === VERSION) {
            FLAG = 0;
            log("flag reset to 0");
        }
        return sendJSON(res, { ok: true });
    }

    // --- normal poll: decide what to tell this dongle ---
    devices[device].running = running;

    let flag = FLAG;

    // If it already runs the target version, nothing to do.
    if (running === VERSION) {
        flag = 0;
    }
    // If we said "apply" but this dongle never downloaded, tell it to
    // download first. Otherwise it would try to apply a file that is
    // not there.
    else if (FLAG === 2 && devices[device].staged !== VERSION) {
        log(device + " has not downloaded yet, sending flag 1 instead");
        flag = 1;
    }

    log(device + " running=" + running + " -> flag=" + flag);

    sendJSON(res, {
        flag:    flag,
        version: VERSION,
        size:    Buffer.byteLength(CODE)
    });
}

// ==================================================================
// API 2 -- the dongle calls this only when flag was 1
//
//   GET /api/getcode?device=N75-0001&version=1.0.1
// ==================================================================
function api2_getcode(res, p) {
    const device = p.device || "unknown";

    devices[device] = devices[device] || {};
    devices[device].staged = VERSION;

    log(device + " downloaded " + Buffer.byteLength(CODE) + " bytes");

    sendText(res, CODE);
}

// ==================================================================
// admin -- change the flag while the server is running
//
//   GET /admin/setflag?flag=1&version=1.0.1
//   GET /admin/status
// ==================================================================
function admin_setflag(res, p) {
    FLAG = parseInt(p.flag, 10) || 0;
    if (p.version) VERSION = p.version;
    log("ADMIN flag=" + FLAG + " version=" + VERSION);
    sendJSON(res, { ok: true, flag: FLAG, version: VERSION });
}

function admin_status(res) {
    sendJSON(res, {
        flag: FLAG,
        version: VERSION,
        codeSize: Buffer.byteLength(CODE),
        devices: devices
    });
}

// ==================================================================
// router
// ==================================================================
http.createServer(function (req, res) {
    const p    = getParams(req.url);
    const path = req.url.split("?")[0];

    if (path === "/api/checkflag") {
        api1_checkflag(res, p);
    } else if (path === "/api/getcode") {
        api2_getcode(res, p);
    } else if (path === "/admin/setflag") {
        admin_setflag(res, p);
    } else if (path === "/admin/status") {
        admin_status(res);
    } else {
        log("404 " + req.url);
        res.writeHead(404);
        res.end();
    }
}).listen(PORT, "0.0.0.0", function () {
    log("server listening on port " + PORT);
    log("flag=" + FLAG + " version=" + VERSION);
    console.log("");
    console.log("  test:      curl \"http://localhost:8080/api/checkflag?device=test&version=0\"");
    console.log("  download:  curl \"http://localhost:8080/admin/setflag?flag=1&version=1.0.1\"");
    console.log("  apply:     curl \"http://localhost:8080/admin/setflag?flag=2\"");
    console.log("  status:    curl \"http://localhost:8080/admin/status\"");
    console.log("");
});
