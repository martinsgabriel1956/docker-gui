const http = require("http");
const fs = require("fs");
const path = require("path");

const [outDir, projectDir, allowedOrigin, portArg] = process.argv.slice(2);
if (!outDir || !projectDir || !allowedOrigin) {
  console.error(
    "uso: node capture-server.cjs <pasta-de-saida> <raiz-do-front> <origem-da-app> [porta]"
  );
  process.exit(1);
}

const port = Number(portArg || 3999);
const libPath = path.join(projectDir, "node_modules/html-to-image/dist/html-to-image.js");
const helpersPath = path.join(__dirname, "capture-helpers.js");

if (!fs.existsSync(libPath)) {
  console.error(`html-to-image não encontrado em ${libPath}`);
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const SCRIPTS = { "/lib.js": libPath, "/helpers.js": helpersPath };

http
  .createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.end();

    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && SCRIPTS[url.pathname]) {
      res.setHeader("Content-Type", "application/javascript");
      return fs.createReadStream(SCRIPTS[url.pathname]).pipe(res);
    }

    if (req.method === "POST" && url.pathname === "/save") {
      const name = `${path.basename(url.searchParams.get("name") || "print")}.png`;
      let body = "";
      req.on("data", chunk => {
        body += chunk;
      });
      req.on("end", () => {
        fs.writeFileSync(
          path.join(outDir, name),
          Buffer.from(body.replace(/^data:image\/png;base64,/, ""), "base64")
        );
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ saved: path.join(outDir, name) }));
      });
      return;
    }

    res.statusCode = 404;
    res.end();
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`capture server em http://localhost:${port} -> ${outDir}`)
  );
