// server.js
import express from "express";
import fs from "fs";
import http from "http";
import { createServer as createViteServer } from "vite";
import "dotenv/config";
import { WebSocketServer } from "ws";
import { initOrchestrator } from "./server/orchestrator.js";

const app = express();
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;

// Initialize the orchestrator singleton and subscribe to its events
const orchestrator = initOrchestrator();
orchestrator.on("log", (evt) => {
  // evt is { session: 'A'|'B', event: string, ... }
  console.log(`[Orchestrator]`, evt);
});
orchestrator.on("error", (err) => {
  console.error(`[Orchestrator ERROR]`, err);
});

// === Middlewares ===
app.use(express.json()); // parse JSON bodies

// === Vite + React client ===
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "custom",
});
app.use(vite.middlewares);

// === Existing token route ===
app.get("/token", async (req, res) => {
  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-realtime-preview-2024-12-17",
          voice: "verse",
        }),
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// === Start the Arena ===
app.post("/arena/start", async (req, res) => {
  try {
    // This will emit logs to your terminal because of our subscriptions above
    orchestrator.start().catch((err) => orchestrator.emit("error", err));
    res.json({ status: "started" });
  } catch (err) {
    console.error("Arena start error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Stop the Arena ===
app.post("/arena/stop", (req, res) => {
  try {
    orchestrator.stop();
    res.json({ status: "stopped" });
  } catch (err) {
    console.error("Arena stop error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Serve React client for all other routes ===
app.use("*", async (req, res, next) => {
  const url = req.originalUrl;
  try {
    const template = await vite.transformIndexHtml(
      url,
      fs.readFileSync("./client/index.html", "utf-8")
    );
    const { render } = await vite.ssrLoadModule(
      "./client/entry-server.jsx"
    );
    const appHtml = await render(url);
    const html = template.replace(
      `<!--ssr-outlet-->`,
      appHtml?.html || ""
    );
    res.status(200).set({ "Content-Type": "text/html" }).end(html);
  } catch (e) {
    vite.ssrFixStacktrace(e);
    next(e);
  }
});

// === HTTP + WebSocket servers ===
const server = http.createServer(app);

// WebSocket endpoint for UI log streaming
const wss = new WebSocketServer({ server, path: "/arena/ws" });
wss.on("connection", (socket) => {
  // forward logs/errors to any UI client
  const sendLog = (event) => socket.send(JSON.stringify(event));
  const sendError = (err) =>
    socket.send(JSON.stringify({ type: "error", error: err.message }));

  orchestrator.on("log", sendLog);
  orchestrator.on("error", sendError);

  socket.on("close", () => {
    orchestrator.off("log", sendLog);
    orchestrator.off("error", sendError);
  });
});

// Start listening
server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
