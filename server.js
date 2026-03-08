require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ══════════════════════════════════════════
//  SOCKET.IO SETUP
// ══════════════════════════════════════════
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════
const API_KEY      = process.env.API_KEY || 'change-this-to-a-secret-key';
const PORT         = process.env.PORT || 3000;
const MC_IP        = process.env.MC_SERVER_IP || 'localhost';
const MC_PORT      = parseInt(process.env.MC_SERVER_PORT) || 25565;
const RANGE_FULL   = parseFloat(process.env.RANGE_FULL)   || 10;
const RANGE_MEDIUM = parseFloat(process.env.RANGE_MEDIUM) || 30;
const RANGE_LOW    = parseFloat(process.env.RANGE_LOW)    || 50;
const VOL_FULL     = parseFloat(process.env.VOL_FULL)     || 1.0;
const VOL_MEDIUM   = parseFloat(process.env.VOL_MEDIUM)   || 0.6;
const VOL_LOW      = parseFloat(process.env.VOL_LOW)      || 0.3;

// ══════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════

/**
 * minecraftPlayers: players currently on the Minecraft server
 * Key: UUID
 * Value: { username, uuid, bedrock, x, y, z, world, lastUpdate }
 */
const minecraftPlayers = new Map();

/**
 * webClients: browser clients connected to voice chat
 * Key: socket.id
 * Value: { username, uuid, socketId }
 */
const webClients = new Map();

/**
 * usernameToSocket: map username -> socket.id for fast lookup
 */
const usernameToSocket = new Map();

// ══════════════════════════════════════════
//  API KEY MIDDLEWARE
// ══════════════════════════════════════════
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// ══════════════════════════════════════════
//  PROXIMITY CALCULATION
// ══════════════════════════════════════════
function distance(a, b) {
  return Math.sqrt(
    Math.pow(a.x - b.x, 2) +
    Math.pow(a.y - b.y, 2) +
    Math.pow(a.z - b.z, 2)
  );
}

function getVolume(dist) {
  if (dist <= RANGE_FULL)   return VOL_FULL;
  if (dist <= RANGE_MEDIUM) return VOL_MEDIUM;
  if (dist <= RANGE_LOW)    return VOL_LOW;
  return 0; // muted
}

/**
 * Calculate volumes for all nearby players from a given player's perspective.
 * Returns: [{ username, uuid, volume, distance, bedrock }]
 */
function getNearbyPlayers(uuid) {
  const speaker = minecraftPlayers.get(uuid);
  if (!speaker) return [];

  const nearby = [];
  for (const [otherUuid, other] of minecraftPlayers) {
    if (otherUuid === uuid) continue;
    if (other.world !== speaker.world) continue; // Different worlds = can't hear

    const dist = distance(speaker, other);
    const vol = getVolume(dist);

    if (vol > 0) {
      nearby.push({
        username: other.username,
        uuid: otherUuid,
        volume: vol,
        distance: Math.round(dist),
        bedrock: other.bedrock
      });
    }
  }
  return nearby;
}

/**
 * After any position update, push new proximity data to all web clients.
 */
function broadcastProximityUpdates() {
  for (const [socketId, client] of webClients) {
    if (!client.uuid) continue;

    const nearby = getNearbyPlayers(client.uuid);
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('proximity_update', { players: nearby });
    }
  }
}

// ══════════════════════════════════════════
//  PLUGIN API ENDPOINTS
// ══════════════════════════════════════════

// Player connected to Minecraft server
app.post('/api/player/connect', requireApiKey, (req, res) => {
  const { username, uuid, bedrock } = req.body;
  if (!username || !uuid) return res.status(400).json({ error: 'Missing fields' });

  // Store or update player entry
  minecraftPlayers.set(uuid, {
    username, uuid, bedrock: !!bedrock,
    x: 0, y: 64, z: 0, world: 'world',
    lastUpdate: Date.now()
  });

  console.log(`[MC] Connected: ${username} (${bedrock ? 'Bedrock' : 'Java'}) UUID: ${uuid}`);

  // If a web client with this username is already waiting, link them
  const socketId = usernameToSocket.get(username.toLowerCase());
  if (socketId) {
    const client = webClients.get(socketId);
    if (client) {
      client.uuid = uuid;
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('mc_connected', { username, uuid, bedrock: !!bedrock });
        console.log(`[VC] Auto-linked ${username} to waiting web client`);
      }
    }
  }

  res.json({ ok: true });
});

// Player position update
app.post('/api/player/position', requireApiKey, (req, res) => {
  const { username, uuid, bedrock, x, y, z, world } = req.body;
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' });

  const existing = minecraftPlayers.get(uuid) || {};
  minecraftPlayers.set(uuid, {
    ...existing,
    username, uuid, bedrock: !!bedrock,
    x, y, z, world: world || 'world',
    lastUpdate: Date.now()
  });

  // Push proximity updates to all web clients
  broadcastProximityUpdates();

  res.json({ ok: true });
});

// Player disconnected from Minecraft
app.post('/api/player/disconnect', requireApiKey, (req, res) => {
  const { uuid } = req.body;
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' });

  const player = minecraftPlayers.get(uuid);
  if (player) {
    console.log(`[MC] Disconnected: ${player.username}`);
    usernameToSocket.delete(player.username.toLowerCase());

    // Notify their web client
    const socketId = usernameToSocket.get(player.username.toLowerCase());
    if (socketId) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.emit('mc_disconnected');
    }
  }

  minecraftPlayers.delete(uuid);
  broadcastProximityUpdates();
  res.json({ ok: true });
});

// Check if a player is online (used by website)
app.get('/api/player/check/:username', (req, res) => {
  const username = req.params.username.toLowerCase();
  for (const [uuid, player] of minecraftPlayers) {
    if (player.username.toLowerCase() === username) {
      return res.json({ online: true, uuid, bedrock: player.bedrock });
    }
  }
  res.json({ online: false });
});

// Get server status
app.get('/api/server/status', async (req, res) => {
  try {
    const util = require('minecraft-server-util');
    const result = await util.status(MC_IP, MC_PORT, { timeout: 3000 });
    res.json({
      online: true,
      players: result.players.online,
      maxPlayers: result.players.max,
      version: result.version.name
    });
  } catch (e) {
    res.json({ online: false, error: e.message });
  }
});

// Get all online players (for website display)
app.get('/api/players', (req, res) => {
  const players = Array.from(minecraftPlayers.values()).map(p => ({
    username: p.username,
    uuid: p.uuid,
    bedrock: p.bedrock
  }));
  res.json({ players });
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ══════════════════════════════════════════
//  SOCKET.IO - WebRTC SIGNALING + VOICE
// ══════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // ── Step 1: Web client registers with their Minecraft username ──
  socket.on('register', ({ username }) => {
    if (!username) return;

    const lowerName = username.toLowerCase();
    console.log(`[WS] Register: ${username} (${socket.id})`);

    // Store web client
    webClients.set(socket.id, { username, uuid: null, socketId: socket.id });
    usernameToSocket.set(lowerName, socket.id);

    // Check if they're already on the Minecraft server
    for (const [uuid, player] of minecraftPlayers) {
      if (player.username.toLowerCase() === lowerName) {
        // They're online! Link them immediately
        const client = webClients.get(socket.id);
        if (client) client.uuid = uuid;

        socket.emit('mc_connected', {
          username: player.username,
          uuid,
          bedrock: player.bedrock
        });

        console.log(`[VC] ${username} is already on MC server, auto-linking`);

        // Send initial proximity data
        const nearby = getNearbyPlayers(uuid);
        socket.emit('proximity_update', { players: nearby });
        return;
      }
    }

    // Not online yet — tell client to wait
    socket.emit('waiting_for_mc', { message: 'Join the Minecraft server to activate voice chat' });
  });

  // ── WebRTC Signaling ──
  // When a client wants to call another player
  socket.on('webrtc_offer', ({ targetUuid, offer }) => {
    const targetSocketId = getSocketByUuid(targetUuid);
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc_offer', {
        fromUuid: getUuidBySocket(socket.id),
        fromUsername: webClients.get(socket.id)?.username,
        offer
      });
    }
  });

  socket.on('webrtc_answer', ({ targetUuid, answer }) => {
    const targetSocketId = getSocketByUuid(targetUuid);
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc_answer', {
        fromUuid: getUuidBySocket(socket.id),
        answer
      });
    }
  });

  socket.on('webrtc_ice', ({ targetUuid, candidate }) => {
    const targetSocketId = getSocketByUuid(targetUuid);
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc_ice', {
        fromUuid: getUuidBySocket(socket.id),
        candidate
      });
    }
  });

  // ── Client disconnect ──
  socket.on('disconnect', () => {
    const client = webClients.get(socket.id);
    if (client) {
      usernameToSocket.delete(client.username.toLowerCase());
      webClients.delete(socket.id);
      console.log(`[WS] Disconnected: ${client.username}`);
    }
  });
});

// ══════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════
function getSocketByUuid(uuid) {
  for (const [socketId, client] of webClients) {
    if (client.uuid === uuid) return socketId;
  }
  return null;
}

function getUuidBySocket(socketId) {
  return webClients.get(socketId)?.uuid || null;
}

// Clean up stale Minecraft players (no update in 30s)
setInterval(() => {
  const now = Date.now();
  for (const [uuid, player] of minecraftPlayers) {
    if (now - player.lastUpdate > 30000) {
      console.log(`[MC] Timeout cleanup: ${player.username}`);
      minecraftPlayers.delete(uuid);
    }
  }
}, 15000);

// ══════════════════════════════════════════
//  START
// ══════════════════════════════════════════
server.listen(PORT, () => {
  console.log('╔════════════════════════════════╗');
  console.log('║   ProximityVC Backend Ready    ║');
  console.log(`║   Port: ${PORT}                    ║`);
  console.log(`║   MC Server: ${MC_IP}:${MC_PORT}  ║`);
  console.log('╚════════════════════════════════╝');
});
