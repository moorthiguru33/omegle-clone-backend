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
  "https://localhost:3000",
  /\.netlify\.app$/,
  /localhost:\d+$/,
  process.env.FRONTEND_URL
].filter(Boolean);

console.log('[INFO] Allowed CORS origins:', allowedOrigins);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') {
        return allowed === origin;
      }
      return allowed.test(origin);
    });
    if (isAllowed) {
      callback(null, true);
    } else {
      console.log(`[CORS] Blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization"]
}));

app.use(express.json({ limit: '1mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - ${req.ip}`);
  next();
});

// Socket.IO configuration with enhanced CORS
const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  allowUpgrades: true,
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  maxHttpBufferSize: 1e6,
  httpCompression: true,
  perMessageDeflate: {
    threshold: 1024,
    concurrencyLimit: 20,
    memLevel: 7
  }
});

// Enhanced User Management System
class UserManager {
  constructor() {
    this.users = new Map();
    this.waitingQueue = {
      male: new Set(),
      female: new Set(),
      other: new Set(),
      any: new Set()
    };
    this.activeConnections = new Map();
    this.statistics = {
      totalConnections: 0,
      activeUsers: 0,
      totalMatches: 0,
      successfulCalls: 0,
      peakConcurrentUsers: 0,
      averageSessionDuration: 0,
      totalReports: 0,
      bannedUsers: new Set()
    };
    this.sessionStartTimes = new Map();
    this.reportHistory = new Map();
  }

  addUser(socketId, userData) {
    if (!userData.userId || !userData.gender) {
      throw new Error('Invalid user data: missing userId or gender');
    }

    if (this.statistics.bannedUsers.has(userData.userId)) {
      throw new Error('User is banned from the service');
    }

    const user = {
      id: userData.userId,
      socketId: socketId,
      gender: userData.gender.toLowerCase(),
      preferredGender: userData.preferredGender ? userData.preferredGender.toLowerCase() : 'any',
      hasFilterCredit: Boolean(userData.hasFilterCredit),
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      isMatched: false,
      partnerId: null,
      country: userData.country || 'unknown',
      userAgent: userData.userAgent || 'unknown',
      reportCount: 0
    };

    this.users.set(socketId, user);
    this.sessionStartTimes.set(socketId, Date.now());
    this.statistics.activeUsers = this.users.size;
    this.statistics.peakConcurrentUsers = Math.max(
      this.statistics.peakConcurrentUsers,
      this.statistics.activeUsers
    );

    console.log(`[SUCCESS] User ${user.id} added (${user.gender}). Active users: ${this.statistics.activeUsers}`);
    return user;
  }

  removeUser(socketId) {
    const user = this.users.get(socketId);
    if (!user) return null;

    const sessionStart = this.sessionStartTimes.get(socketId);
    if (sessionStart) {
      const sessionDuration = Date.now() - sessionStart;
      this.updateAverageSessionDuration(sessionDuration);
      this.sessionStartTimes.delete(socketId);
    }

    this.removeFromQueue(user);
    
    if (user.partnerId) {
      const partner = this.findUserBySocketId(user.partnerId);
      if (partner) {
        partner.partnerId = null;
        partner.isMatched = false;
        io.to(partner.socketId).emit('partnerDisconnected');
      }
    }

    this.users.delete(socketId);
    this.activeConnections.delete(socketId);
    this.statistics.activeUsers = this.users.size;

    console.log(`[CLEANUP] User ${user.id} removed. Active users: ${this.statistics.activeUsers}`);
    return user;
  }

  updateAverageSessionDuration(newDuration) {
    const currentAvg = this.statistics.averageSessionDuration;
    const totalSessions = this.statistics.totalConnections;
    if (totalSessions === 0) {
      this.statistics.averageSessionDuration = newDuration;
    } else {
      this.statistics.averageSessionDuration =
        ((currentAvg * totalSessions) + newDuration) / (totalSessions + 1);
    }
  }

  findUserBySocketId(socketId) {
    return this.users.get(socketId);
  }

  addToQueue(user) {
    if (user.isMatched) return;
    this.removeFromQueue(user);
    
    let targetQueue = 'any';
    if (user.hasFilterCredit && user.preferredGender && user.preferredGender !== 'any') {
      targetQueue = user.preferredGender;
    }

    if (this.waitingQueue[targetQueue]) {
      this.waitingQueue[targetQueue].add(user);
      console.log(`[QUEUE] User ${user.id} added to ${targetQueue} queue (size: ${this.waitingQueue[targetQueue].size})`);
    }
  }

  removeFromQueue(user) {
    Object.values(this.waitingQueue).forEach(queue => {
      queue.delete(user);
    });
  }

  findMatch(user) {
    if (user.isMatched) return null;

    let searchQueues = ['any'];
    if (user.hasFilterCredit && user.preferredGender && user.preferredGender !== 'any') {
      searchQueues = [user.preferredGender, 'any'];
    } else {
      searchQueues = ['male', 'female', 'other', 'any'];
    }

    for (const queueName of searchQueues) {
      const queue = this.waitingQueue[queueName];
      if (!queue) continue;

      const queueArray = Array.from(queue);
      for (const potentialMatch of queueArray) {
        if (potentialMatch.socketId === user.socketId || potentialMatch.isMatched) {
          continue;
        }

        if (this.areUsersCompatible(user, potentialMatch)) {
          this.removeFromQueue(user);
          this.removeFromQueue(potentialMatch);
          
          user.isMatched = true;
          user.partnerId = potentialMatch.socketId;
          potentialMatch.isMatched = true;
          potentialMatch.partnerId = user.socketId;
          
          this.statistics.totalMatches++;
          console.log(`[MATCH] Match found: ${user.id} <-> ${potentialMatch.id}`);
          return potentialMatch;
        }
      }
    }
    return null;
  }

  areUsersCompatible(user1, user2) {
    if (user1.socketId === user2.socketId) return false;
    if (user1.isMatched || user2.isMatched) return false;
    if (user1.id === user2.id) return false;

    if (this.statistics.bannedUsers.has(user1.id) || this.statistics.bannedUsers.has(user2.id)) {
      return false;
    }

    if (user2.preferredGender && user2.preferredGender !== 'any' && user2.hasFilterCredit) {
      if (user2.preferredGender !== user1.gender) return false;
    }

    if (user1.preferredGender && user1.preferredGender !== 'any' && user1.hasFilterCredit) {
      if (user1.preferredGender !== user2.gender) return false;
    }

    return true;
  }

  updateUserActivity(socketId) {
    const user = this.users.get(socketId);
    if (user) {
      user.lastActivity = Date.now();
    }
  }

  reportUser(reporterId, reportedUserId, reason) {
    if (!reportedUserId || !reason) return false;
    
    const reportKey = `${reporterId}-${reportedUserId}`;
    if (this.reportHistory.has(reportKey)) {
      console.log(`[REPORT] Duplicate report ignored: ${reportKey}`);
      return false;
    }

    this.reportHistory.set(reportKey, {
      reporterId,
      reportedUserId,
      reason,
      timestamp: Date.now()
    });
    
    this.statistics.totalReports++;

    for (const user of this.users.values()) {
      if (user.id === reportedUserId) {
        user.reportCount = (user.reportCount || 0) + 1;
        
        if (user.reportCount >= 3) {
          this.statistics.bannedUsers.add(user.id);
          console.log(`[BAN] User ${user.id} auto-banned after ${user.reportCount} reports`);
          
          const socket = io.sockets.sockets.get(user.socketId);
          if (socket) {
            socket.emit('banned', { message: 'You have been banned due to multiple reports' });
            socket.disconnect(true);
          }
        }
        break;
      }
    }

    console.log(`[REPORT] User reported: ${reportedUserId} by ${reporterId} for: ${reason}`);
    return true;
  }

  cleanupInactiveUsers() {
    const now = Date.now();
    const inactivityThreshold = 5 * 60 * 1000;
    let cleanedCount = 0;

    for (const [socketId, user] of this.users) {
      if (now - user.lastActivity > inactivityThreshold) {
        console.log(`[CLEANUP] Removing inactive user: ${user.id}`);
        this.removeUser(socketId);
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.disconnect(true);
        }
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[CLEANUP] Cleaned up ${cleanedCount} inactive users`);
    }

    const dayAgo = now - (24 * 60 * 60 * 1000);
    for (const [key, report] of this.reportHistory) {
      if (report.timestamp < dayAgo) {
        this.reportHistory.delete(key);
      }
    }
  }

  getQueueStatus() {
    const status = {};
    for (const [queueName, queue] of Object.entries(this.waitingQueue)) {
      status[queueName] = queue.size;
    }
    return status;
  }

  getStatistics() {
    return {
      ...this.statistics,
      queueStatus: this.getQueueStatus(),
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      memoryUsage: process.memoryUsage(),
      bannedUsersCount: this.statistics.bannedUsers.size
    };
  }

  getUserDistribution() {
    const distribution = { male: 0, female: 0, other: 0 };
    for (const user of this.users.values()) {
      if (distribution.hasOwnProperty(user.gender)) {
        distribution[user.gender]++;
      }
    }
    return distribution;
  }
}

const userManager = new UserManager();

// Cleanup intervals
setInterval(() => {
  userManager.cleanupInactiveUsers();
}, 2 * 60 * 1000);

setInterval(() => {
  const stats = userManager.getStatistics();
  console.log(`[STATS] ${stats.activeUsers} active, ${stats.totalMatches} total matches, ${stats.totalReports} reports`);
}, 10 * 60 * 1000);

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: {
    error: 'Too many requests from this IP, please try again later',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(limiter);

// Enhanced socket connection handling
io.on('connection', (socket) => {
  console.log(`[CONNECTION] New connection: ${socket.id} from ${socket.handshake.address}`);
  userManager.statistics.totalConnections++;
  userManager.activeConnections.set(socket.id, {
    socketId: socket.id,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
    ip: socket.handshake.address,
    userAgent: socket.handshake.headers['user-agent']
  });

  const connectionTimeout = setTimeout(() => {
    console.log(`[TIMEOUT] Connection timeout for ${socket.id}`);
    socket.emit('timeout', { message: 'Connection timeout due to inactivity' });
    socket.disconnect(true);
  }, 15 * 60 * 1000);

  const clearTimeoutOnActivity = () => {
    clearTimeout(connectionTimeout);
    userManager.updateUserActivity(socket.id);
  };

  // Enhanced find partner handler with detailed logging
  socket.on('findPartner', (userData) => {
    try {
      console.log(`[FIND_PARTNER] Request from ${userData.userId} (${socket.id})`);
      console.log(`[USER_DATA] Gender: ${userData.gender}, Preference: ${userData.preferredGender}, Has Credits: ${userData.hasFilterCredit}`);
      
      clearTimeoutOnActivity();

      if (!userData.userId || !userData.gender) {
        console.error(`[ERROR] Invalid user data from ${socket.id}:`, userData);
        socket.emit('error', { message: 'Missing required user data' });
        return;
      }

      const validGenders = ['male', 'female', 'other'];
      const validPreferences = ['male', 'female', 'other', 'any'];

      if (!validGenders.includes(userData.gender.toLowerCase())) {
        console.error(`[ERROR] Invalid gender from ${socket.id}: ${userData.gender}`);
        socket.emit('error', { message: 'Invalid gender value' });
        return;
      }

      if (userData.preferredGender && !validPreferences.includes(userData.preferredGender.toLowerCase())) {
        console.log(`[WARNING] Invalid preference from ${socket.id}, defaulting to 'any'`);
        userData.preferredGender = 'any';
      }

      userData.userAgent = socket.handshake.headers['user-agent'];
      userData.country = socket.handshake.headers['cf-ipcountry'] || 'unknown';

      console.log(`[QUEUE] Adding user to matching system...`);
      const user = userManager.addUser(socket.id, userData);

      console.log(`[MATCHING] Looking for match for ${user.id}...`);
      const match = userManager.findMatch(user);

      if (match) {
        console.log(`[MATCH_FOUND] ${user.id} matched with ${match.id}`);
        console.log(`[MATCH_DETAILS] User1: ${user.gender}->${user.preferredGender}, User2: ${match.gender}->${match.preferredGender}`);

        // Send match notifications with partner info
        socket.emit('matched', {
          partnerId: match.socketId,
          partnerGender: match.gender,
          matchTime: Date.now()
        });

        const partnerSocket = io.sockets.sockets.get(match.socketId);
        if (partnerSocket) {
          partnerSocket.emit('matched', {
            partnerId: socket.id,
            partnerGender: user.gender,
            matchTime: Date.now()
          });
          console.log(`[SUCCESS] Match notifications sent to both users`);
        } else {
          console.error(`[ERROR] Partner socket not available: ${match.socketId}`);
          // Clean up the match
          user.isMatched = false;
          user.partnerId = null;
          match.isMatched = false;
          match.partnerId = null;
          userManager.addToQueue(user);
          socket.emit('waiting');
        }
      } else {
        console.log(`[QUEUE] No match found for ${user.id}, adding to queue`);
        userManager.addToQueue(user);

        const queueStatus = userManager.getQueueStatus();
        console.log(`[QUEUE_STATUS] Current queues:`, queueStatus);

        socket.emit('waiting', {
          queuePosition: Object.values(queueStatus).reduce((a, b) => a + b, 0),
          estimatedWait: '30s'
        });
      }

    } catch (error) {
      console.error(`[ERROR] findPartner error for ${socket.id}:`, error);
      socket.emit('error', { message: error.message });
    }
  });

  // Enhanced WebRTC signaling handlers with detailed logging
  socket.on('offer', (offer) => {
    try {
      clearTimeoutOnActivity();

      if (!offer || !offer.type || !offer.sdp) {
        console.error(`[ERROR] Invalid offer received from ${socket.id}:`, offer);
        socket.emit('error', { message: 'Invalid offer format' });
        return;
      }

      const user = userManager.findUserBySocketId(socket.id);
      if (!user) {
        console.error(`[ERROR] User not found for socket ${socket.id}`);
        socket.emit('error', { message: 'User session not found' });
        return;
      }

      if (!user.partnerId) {
        console.error(`[ERROR] No partner found for user ${user.id}`);
        socket.emit('error', { message: 'No partner available' });
        return;
      }

      const partnerSocket = io.sockets.sockets.get(user.partnerId);
      if (!partnerSocket) {
        console.error(`[ERROR] Partner socket not found: ${user.partnerId}`);
        socket.emit('partnerDisconnected');
        user.partnerId = null;
        user.isMatched = false;
        return;
      }

      console.log(`[WEBRTC] Relaying offer from ${socket.id} (${user.id}) to ${user.partnerId}`);
      console.log(`[WEBRTC] Offer type: ${offer.type}, SDP length: ${offer.sdp.length}`);

      partnerSocket.emit('offer', offer);

    } catch (error) {
      console.error(`[ERROR] Offer relay error for ${socket.id}:`, error);
      socket.emit('error', { message: 'Failed to relay offer' });
    }
  });

  socket.on('answer', (answer) => {
    try {
      clearTimeoutOnActivity();

      if (!answer || !answer.type || !answer.sdp) {
        console.error(`[ERROR] Invalid answer received from ${socket.id}:`, answer);
        socket.emit('error', { message: 'Invalid answer format' });
        return;
      }

      const user = userManager.findUserBySocketId(socket.id);
      if (!user) {
        console.error(`[ERROR] User not found for socket ${socket.id}`);
        socket.emit('error', { message: 'User session not found' });
        return;
      }

      if (!user.partnerId) {
        console.error(`[ERROR] No partner found for user ${user.id}`);
        socket.emit('error', { message: 'No partner available' });
        return;
      }

      const partnerSocket = io.sockets.sockets.get(user.partnerId);
      if (!partnerSocket) {
        console.error(`[ERROR] Partner socket not found: ${user.partnerId}`);
        socket.emit('partnerDisconnected');
        user.partnerId = null;
        user.isMatched = false;
        return;
      }

      console.log(`[WEBRTC] Relaying answer from ${socket.id} (${user.id}) to ${user.partnerId}`);
      console.log(`[WEBRTC] Answer type: ${answer.type}, SDP length: ${answer.sdp.length}`);

      partnerSocket.emit('answer', answer);
      userManager.statistics.successfulCalls++;

      console.log(`[SUCCESS] WebRTC negotiation completed between ${user.id} and partner`);

    } catch (error) {
      console.error(`[ERROR] Answer relay error for ${socket.id}:`, error);
      socket.emit('error', { message: 'Failed to relay answer' });
    }
  });

  socket.on('ice-candidate', (candidate) => {
    try {
      clearTimeoutOnActivity();

      if (!candidate) {
        console.error(`[ERROR] Invalid ICE candidate received from ${socket.id}`);
        return;
      }

      const user = userManager.findUserBySocketId(socket.id);
      if (!user) {
        console.error(`[ERROR] User not found for ICE candidate from ${socket.id}`);
        return;
      }

      if (!user.partnerId) {
        console.error(`[ERROR] No partner for ICE candidate from user ${user.id}`);
        return;
      }

      const partnerSocket = io.sockets.sockets.get(user.partnerId);
      if (!partnerSocket) {
        console.error(`[ERROR] Partner socket not found for ICE candidate: ${user.partnerId}`);
        socket.emit('partnerDisconnected');
        user.partnerId = null;
        user.isMatched = false;
        return;
      }

      console.log(`[WEBRTC] Relaying ICE candidate from ${socket.id} to ${user.partnerId}`);
      console.log(`[WEBRTC] Candidate: ${candidate.candidate ? candidate.candidate.substring(0, 50) + '...' : 'end-of-candidates'}`);

      partnerSocket.emit('ice-candidate', candidate);

    } catch (error) {
      console.error(`[ERROR] ICE candidate relay error for ${socket.id}:`, error);
    }
  });

  // End call handler
  socket.on('endCall', () => {
    try {
      console.log(`[END_CALL] End call from ${socket.id}`);
      clearTimeoutOnActivity();
      
      const user = userManager.findUserBySocketId(socket.id);
      if (user && user.partnerId) {
        const partnerSocket = io.sockets.sockets.get(user.partnerId);
        if (partnerSocket) {
          partnerSocket.emit('partnerDisconnected');
        }

        const partner = userManager.findUserBySocketId(user.partnerId);
        if (partner) {
          partner.partnerId = null;
          partner.isMatched = false;
        }

        user.partnerId = null;
        user.isMatched = false;
      }

    } catch (error) {
      console.error(`[ERROR] End call error:`, error);
    }
  });

  // Report user handler
  socket.on('reportUser', (reportData) => {
    try {
      console.log(`[REPORT] User report from ${socket.id}:`, reportData);
      clearTimeoutOnActivity();
      
      const user = userManager.findUserBySocketId(socket.id);
      if (user && user.partnerId && reportData.reason) {
        const partner = userManager.findUserBySocketId(user.partnerId);
        if (partner) {
          const reported = userManager.reportUser(user.id, partner.id, reportData.reason);
          if (reported) {
            const reportedSocket = io.sockets.sockets.get(user.partnerId);
            if (reportedSocket) {
              reportedSocket.emit('reported', {
                message: 'You have been reported for inappropriate behavior',
                reason: reportData.reason
              });
              setTimeout(() => {
                reportedSocket.disconnect(true);
              }, 2000);
            }
            socket.emit('reportReceived', { message: 'Report submitted successfully' });
          } else {
            socket.emit('error', { message: 'Report could not be processed' });
          }
        }
      }
    } catch (error) {
      console.error(`[ERROR] Report handling error:`, error);
    }
  });

  // Heartbeat handler
  socket.on('ping', () => {
    clearTimeoutOnActivity();
    socket.emit('pong');
  });

  // Disconnect handler
  socket.on('disconnect', (reason) => {
    console.log(`[DISCONNECT] User disconnected: ${socket.id}, reason: ${reason}`);
    clearTimeout(connectionTimeout);
    userManager.removeUser(socket.id);
  });

  // Error handler
  socket.on('error', (error) => {
    console.error(`[ERROR] Socket error for ${socket.id}:`, error);
    clearTimeoutOnActivity();
  });

  // Activity tracker
  socket.onAny((eventName) => {
    if (eventName !== 'ping' && eventName !== 'pong') {
      userManager.updateUserActivity(socket.id);
    }
  });

  // Send welcome message
  socket.emit('connected', {
    serverId: process.env.RAILWAY_SERVICE_ID || 'local',
    serverTime: Date.now(),
    features: ['video', 'audio', 'gender-filter', 'reporting', 'auto-moderation'],
    version: '6.0.0'
  });
});

// API Routes (keeping existing routes)
app.get('/', (req, res) => {
  const stats = userManager.getStatistics();
  const distribution = userManager.getUserDistribution();
  res.json({
    status: 'Enhanced Omegle Clone Server - ONLINE',
    version: '6.0.0 - Production Ready',
    timestamp: stats.timestamp,
    uptime: `${Math.floor(stats.uptime / 3600)}h ${Math.floor((stats.uptime % 3600) / 60)}m`,
    environment: process.env.NODE_ENV || 'development',
    statistics: {
      totalConnections: stats.totalConnections,
      activeUsers: stats.activeUsers,
      peakConcurrentUsers: stats.peakConcurrentUsers,
      totalMatches: stats.totalMatches,
      successfulCalls: stats.successfulCalls,
      totalReports: stats.totalReports,
      bannedUsers: stats.bannedUsersCount,
      successRate: stats.totalMatches > 0 ?
        `${((stats.successfulCalls / stats.totalMatches) * 100).toFixed(2)}%` : '0%',
      averageSessionDuration: `${Math.round(stats.averageSessionDuration / 1000)}s`
    },
    queues: stats.queueStatus,
    userDistribution: distribution,
    server: {
      nodeVersion: process.version,
      platform: process.platform,
      memoryUsage: {
        rss: `${Math.round(stats.memoryUsage.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(stats.memoryUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(stats.memoryUsage.heapTotal / 1024 / 1024)}MB`
      }
    },
    features: [
      'WebRTC Video Chat',
      'Gender Filtering',
      'Auto-Moderation',
      'Real-time Matching',
      'Mobile Support',
      'User Reporting',
      'Automatic Cleanup'
    ]
  });
});

app.get('/health', (req, res) => {
  const healthy = userManager.statistics.activeUsers >= 0;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    activeConnections: userManager.statistics.activeUsers,
    checks: {
      memory: process.memoryUsage().heapUsed < 500 * 1024 * 1024 ? 'OK' : 'HIGH',
      connections: userManager.statistics.activeUsers < 1000 ? 'OK' : 'HIGH',
      queue: Object.values(userManager.getQueueStatus()).reduce((a, b) => a + b, 0) < 100 ? 'OK' : 'HIGH'
    }
  });
});

app.get('/stats', (req, res) => {
  const stats = userManager.getStatistics();
  const distribution = userManager.getUserDistribution();
  res.json({
    ...stats,
    userDistribution: distribution,
    server: {
      nodeVersion: process.version,
      platform: process.platform,
      pid: process.pid,
      uptime: process.uptime(),
      startTime: new Date(Date.now() - process.uptime() * 1000).toISOString()
    }
  });
});

app.get('/api/queue', (req, res) => {
  const queueStatus = userManager.getQueueStatus();
  const totalWaiting = Object.values(queueStatus).reduce((sum, count) => sum + count, 0);
  res.json({
    queues: queueStatus,
    totalWaiting,
    estimatedWaitTime: totalWaiting > 10 ? '30s' : totalWaiting > 5 ? '15s' : '5s',
    timestamp: new Date().toISOString()
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('[ERROR] Express error:', err);
  const isDevelopment = process.env.NODE_ENV === 'development';
  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: isDevelopment ? err.message : 'Something went wrong',
    timestamp: new Date().toISOString(),
    ...(isDevelopment && { stack: err.stack })
  });
});

app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`,
    availableRoutes: ['/', '/health', '/stats', '/api/queue'],
    timestamp: new Date().toISOString()
  });
});

// Process error handling
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  if (process.env.NODE_ENV === 'production') {
    console.log('[SHUTDOWN] Attempting graceful shutdown...');
    server.close(() => {
      console.log('[SUCCESS] HTTP server closed');
      process.exit(1);
    });
    setTimeout(() => {
      console.log('[FORCE] Forced exit after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`[SHUTDOWN] Received ${signal}, starting graceful shutdown...`);
  server.close(() => {
    console.log('[SUCCESS] HTTP server closed');
    io.close(() => {
      console.log('[SUCCESS] Socket.IO server closed');
      console.log('[SUCCESS] Graceful shutdown completed');
      process.exit(0);
    });
  });
  setTimeout(() => {
    console.log('[FORCE] Force shutdown after timeout');
    process.exit(1);
  }, 15000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Enhanced Omegle Server running on port ${PORT}`);
  console.log(`[ENV] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[CORS] CORS enabled for ${allowedOrigins.length} origins`);
  console.log(`[FEATURES] Enhanced monitoring, auto-moderation, and security enabled`);
  console.log(`[READY] Server ready to accept connections`);
});

module.exports = { app, server, io, userManager };
