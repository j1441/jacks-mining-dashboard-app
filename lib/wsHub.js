// lib/wsHub.js — WebSocket broadcast hub: attaches a ws.Server at /ws on the given
// HTTP server, JSON-broadcasts to all live clients, and prunes dead sockets with a
// 30 s ping/pong heartbeat. Single responsibility: fan-out; it never builds payloads.
'use strict';

const { WebSocketServer } = require('ws');

const HEARTBEAT_MS = 30 * 1000;
const log = (...a) => console.log('[wsHub]', ...a);

function createWsHub(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (err) => log('client error:', err.message));
  });
  wss.on('error', (err) => log('server error:', err.message));

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_e) { ws.terminate(); }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  return {
    broadcast(obj) {
      let msg;
      try { msg = JSON.stringify(obj); } catch (e) { log('unserializable broadcast dropped:', e.message); return; }
      for (const ws of wss.clients) {
        if (ws.readyState === ws.OPEN) ws.send(msg, () => {});
      }
    },
    clientCount() {
      return wss.clients.size;
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

module.exports = { createWsHub };
