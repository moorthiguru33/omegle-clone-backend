/**
 * Full Production Omegle Clone Backend - server.js
 * Supports: Netlify frontend + Railway backend, WebRTC signaling, gender filters, reporting, connection stats
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration
const allowedOrigins = [
  "https://lambent-biscuit-2313da.netlify.app",
  "http://localhost:3000",
  /\.netlify\.app$/,
  /localhost:\d+$/,
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') return allowed === origin;
      return allowed.test(origin);
    });
    if (isAllowed) {
      callback(null, true);
    } else {
      console.log(`❌ CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// JSON body parsing
app.use(express.json({ limit: '1mb' }));

// Add request start time for timing headers
app.use((req, res, next) => {
  req.startTime = Date.now();
  next();
});

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - ${req.ip}`);
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests from this IP, try again later', retryAfter: 60 },
  standardHeaders: true
});
app.use(limiter);

// =======================
// User Manager Class
// =======================
class UserManager {
  constructor() {
    this.users = new Map();
    this.waitingQueue = { male: new Set(), female: new Set(), other: new Set(), any: new Set() };
    this.activeConnections = new Map();
    this.statistics = {
      totalConnections: 0,
      activeUsers: 0,
      totalMatches: 0,
      successfulCalls: 0,
      peakConcurrentUsers: 0,
      averageSessionDuration: 0
    };
    this.sessionStartTimes = new Map();
  }

  addUser(socketId, data) {
    const user = {
      id: data.userId,
      socketId,
      gender: data.gender,
      preferredGender: data.preferredGender || 'any',
      hasFilterCredit: !!data.hasFilterCredit,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      isMatched: false,
      partnerId: null,
      country: data.country || 'unknown',
      userAgent: data.userAgent || 'unknown'
    };
    this.users.set(socketId, user);
    this.sessionStartTimes.set(socketId, Date.now());
    this.statistics.activeUsers = this.users.size;
    this.statistics.peakConcurrentUsers = Math.max(this.statistics.peakConcurrentUsers, this.statistics.activeUsers);
    return user;
  }

  removeUser(socketId) {
    const user = this.users.get(socketId);
    if (!user) return;
    const start = this.sessionStartTimes.get(socketId);
    if (start) {
      const dur = Date.now() - start;
      this.updateAverageSessionDuration(dur);
    }
    this.removeFromQueue(user);
    if (user.partnerId) {
      const partner = this.users.get(user.partnerId);
      if (partner) {
        partner.partnerId = null;
        partner.isMatched = false;
        io.to(partner.socketId).emit('partnerDisconnected');
      }
    }
    this.users.delete(socketId);
    this.statistics.activeUsers = this.users.size;
  }

  updateAverageSessionDuration(dur) {
    const avg = this.statistics.averageSessionDuration;
    const total = this.statistics.totalConnections;
    this.statistics.averageSessionDuration =
      total === 0 ? dur : ((avg * total) + dur) / (total + 1);
  }

  removeFromQueue(user) {
    Object.values(this.waitingQueue).forEach(q => q.delete(user));
  }

  addToQueue(user) {
    this.removeFromQueue(user);
    let target = 'any';
    if (user.hasFilterCredit && user.preferredGender !== 'any') target = user.preferredGender;
    this.waitingQueue[target].add(user);
  }

  findMatch(user) {
    const queues = (user.hasFilterCredit && user.preferredGender !== 'any')
      ? [user.preferredGender, 'any']
      : ['male', 'female', 'other', 'any'];
    for (const q of queues) {
      for (const potential of Array.from(this.waitingQueue[q])) {
        if (potential.socketId !== user.socketId && !potential.isMatched &&
            this.areUsersCompatible(user, potential)) {
          this.removeFromQueue(user);
          this.removeFromQueue(potential);
          user.isMatched = true;
          potential.isMatched = true;
          user.partnerId = potential.socketId;
          potential.partnerId = user.socketId;
          this.statistics.totalMatches++;
          return potential;
        }
      }
    }
    return null;
  }

  areUsersCompatible(a, b) {
    if (a.id === b.id || a.isMatched || b.isMatched) return false;
    if (b.hasFilterCredit && b.preferredGender !== 'any' && b.preferredGender !== a.gender) return false;
    if (a.hasFilterCredit && a.preferredGender !== 'any' && a.preferredGender !== b.gender) return false;
    return true;
  }

  getQueueStatus() {
    const out = {};
    for (const [k, set] of Object.entries(this.waitingQueue)) out[k] = set.size;
    return out;
  }

  getStatistics() {
    return {
      ...this.statistics,
      queueStatus: this.getQueueStatus(),
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      memoryUsage: process.memoryUsage()
    };
  }
}

const userManager = new UserManager();

// Cleanup inactive users
setInterval(() => {
  const now = Date.now();
  for (const [sid, user] of userManager.users) {
    if (now - user.lastActivity > 5 * 60 * 1000) {
      console.log(`🧹 Removing inactive: ${user.id}`);
      userManager.removeUser(sid);
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.disconnect(true);
    }
  }
}, 2 * 60 * 1000);

// =======================
// Socket.IO
// =======================
const io = socketIo(server, {
  cors: { origin: allowedOrigins, credentials: true },
  transports: ['websocket', 'polling']
});

io.on('connection', socket => {
  console.log(`🔌 Connect ${socket.id} from ${socket.handshake.address}`);
  userManager.statistics.totalConnections++;

  socket.on('findPartner', data => {
    try {
      data.userAgent = socket.handshake.headers['user-agent'];
      data.country = socket.handshake.headers['cf-ipcountry'] || 'unknown';
      const user = userManager.addUser(socket.id, data);
      const match = userManager.findMatch(user);
      if (match) {
        socket.emit('matched', match.socketId);
        io.to(match.socketId).emit('matched', socket.id);
      } else {
        userManager.addToQueue(user);
        socket.emit('waiting');
      }
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('offer', offer => {
    const u = userManager.users.get(socket.id);
    if (u?.partnerId) io.to(u.partnerId).emit('offer', offer);
  });

  socket.on('answer', answer => {
    const u = userManager.users.get(socket.id);
    if (u?.partnerId) {
      io.to(u.partnerId).emit('answer', answer);
      userManager.statistics.successfulCalls++;
    }
  });

  socket.on('ice-candidate', cand => {
    const u = userManager.users.get(socket.id);
    if (u?.partnerId) io.to(u.partnerId).emit('ice-candidate', cand);
  });

  socket.on('endCall', () => { userManager.removeUser(socket.id); });

  socket.on('disconnect', reason => {
    console.log(`❌ Disconnect ${socket.id} reason: ${reason}`);
    userManager.removeUser(socket.id);
  });

  socket.onAny(eventName => {
    if (eventName !== 'ping' && eventName !== 'pong')
      userManager.users.get(socket.id).lastActivity = Date.now();
  });
});

// =======================
// API routes
// =======================
app.get('/', (req, res) => {
  res.json({
    status: 'Omegle Clone Server',
    stats: userManager.getStatistics()
  });
});
app.get('/health', (_req, res) => res.sendStatus(200));
app.get('/stats', (_req, res) => res.json(userManager.getStatistics()));

// =======================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
