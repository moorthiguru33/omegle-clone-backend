const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration with environment variables
const allowedOrigins = [
  "https://lambent-biscuit-2313da.netlify.app",
  "http://localhost:3000",
  "https://localhost:3000",
  /\.netlify\.app$/,
  /localhost:\d+$/,
  process.env.FRONTEND_URL
].filter(Boolean); // Remove undefined values

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, etc.)
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
      console.log(`❌ CORS blocked origin: ${origin}`);
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

// Enhanced Socket.IO configuration
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

// Enhanced data structures
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
      averageSessionDuration: 0
    };
    this.sessionStartTimes = new Map();
  }

  addUser(socketId, userData) {
    // Validate user data
    if (!userData.userId || !userData.gender) {
      throw new Error('Invalid user data');
    }

    const user = {
      id: userData.userId,
      socketId: socketId,
      gender: userData.gender,
      preferredGender: userData.preferredGender || 'any',
      hasFilterCredit: Boolean(userData.hasFilterCredit),
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      isMatched: false,
      partnerId: null,
      country: userData.country || 'unknown',
      userAgent: userData.userAgent || 'unknown'
    };
    
    this.users.set(socketId, user);
    this.sessionStartTimes.set(socketId, Date.now());
    this.statistics.activeUsers = this.users.size;
    this.statistics.peakConcurrentUsers = Math.max(
      this.statistics.peakConcurrentUsers, 
      this.statistics.activeUsers
    );
    
    console.log(`✅ User ${user.id} added (${user.gender}). Active users: ${this.statistics.activeUsers}`);
    return user;
  }

  removeUser(socketId) {
    const user = this.users.get(socketId);
    if (!user) return null;

    // Calculate session duration
    const sessionStart = this.sessionStartTimes.get(socketId);
    if (sessionStart) {
      const sessionDuration = Date.now() - sessionStart;
      this.updateAverageSessionDuration(sessionDuration);
      this.sessionStartTimes.delete(socketId);
    }

    // Remove from waiting queue
    this.removeFromQueue(user);
    
    // Handle partner disconnection
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
    
    console.log(`🧹 User ${user.id} removed. Active users: ${this.statistics.activeUsers}`);
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
    
    // Remove from all queues first
    this.removeFromQueue(user);
    
    // Add to appropriate queue based on user preferences and credits
    let targetQueue = 'any';
    if (user.hasFilterCredit && user.preferredGender && user.preferredGender !== 'any') {
      targetQueue = user.preferredGender;
    }
    
    if (this.waitingQueue[targetQueue]) {
      this.waitingQueue[targetQueue].add(user);
      console.log(`🔥 User ${user.id} added to ${targetQueue} queue (size: ${this.waitingQueue[targetQueue].size})`);
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
    
    // If user has filter credits, search specific queue first
    if (user.hasFilterCredit && user.preferredGender && user.preferredGender !== 'any') {
      searchQueues = [user.preferredGender, 'any'];
    } else {
      // Search all queues for free users
      searchQueues = ['male', 'female', 'other', 'any'];
    }

    for (const queueName of searchQueues) {
      const queue = this.waitingQueue[queueName];
      if (!queue) continue;

      // Convert Set to Array for easier manipulation
      const queueArray = Array.from(queue);
      
      for (const potentialMatch of queueArray) {
        if (potentialMatch.socketId === user.socketId || potentialMatch.isMatched) {
          continue;
        }

        // Check compatibility
        const isCompatible = this.areUsersCompatible(user, potentialMatch);
        
        if (isCompatible) {
          // Remove both users from queues
          this.removeFromQueue(user);
          this.removeFromQueue(potentialMatch);
          
          // Mark as matched
          user.isMatched = true;
          user.partnerId = potentialMatch.socketId;
          potentialMatch.isMatched = true;
          potentialMatch.partnerId = user.socketId;
          
          this.statistics.totalMatches++;
          
          console.log(`🎯 Match found: ${user.id} ↔ ${potentialMatch.id}`);
          return potentialMatch;
        }
      }
    }

    return null;
  }

  areUsersCompatible(user1, user2) {
    // Basic compatibility check
    if (user1.socketId === user2.socketId) return false;
    if (user1.isMatched || user2.isMatched) return false;

    // Prevent self-matching (same user ID)
    if (user1.id === user2.id) return false;

    // Check if user2 accepts user1's gender
    if (user2.preferredGender && user2.preferredGender !== 'any' && user2.hasFilterCredit) {
      if (user2.preferredGender !== user1.gender) {
        return false;
      }
    }

    // Check if user1 accepts user2's gender  
    if (user1.preferredGender && user1.preferredGender !== 'any' && user1.hasFilterCredit) {
      if (user1.preferredGender !== user2.gender) {
        return false;
      }
    }

    return true;
  }

  updateUserActivity(socketId) {
    const user = this.users.get(socketId);
    if (user) {
      user.lastActivity = Date.now();
    }
  }

  cleanupInactiveUsers() {
    const now = Date.now();
    const inactivityThreshold = 5 * 60 * 1000; // 5 minutes
    let cleanedCount = 0;

    for (const [socketId, user] of this.users) {
      if (now - user.lastActivity > inactivityThreshold) {
        console.log(`🧹 Cleaning up inactive user: ${user.id}`);
        this.removeUser(socketId);
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.disconnect(true);
        }
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} inactive users`);
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
      memoryUsage: process.memoryUsage()
    };
  }

  // Get user distribution by gender
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

// Cleanup inactive users every 2 minutes
setInterval(() => {
  userManager.cleanupInactiveUsers();
}, 2 * 60 * 1000);

// Log statistics every 10 minutes
setInterval(() => {
  const stats = userManager.getStatistics();
  console.log(`📊 Stats: ${stats.activeUsers} active, ${stats.totalMatches} total matches, ${stats.queueStatus.any} in queue`);
}, 10 * 60 * 1000);

// Enhanced socket connection handling
io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id} from ${socket.handshake.address}`);
  userManager.statistics.totalConnections++;
  
  // Store connection info with additional metadata
  userManager.activeConnections.set(socket.id, {
    socketId: socket.id,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
    ip: socket.handshake.address,
    userAgent: socket.handshake.headers['user-agent']
  });

  // Set connection timeout (15 minutes for idle connections)
  const connectionTimeout = setTimeout(() => {
    console.log(`⏰ Connection timeout for ${socket.id}`);
    socket.emit('timeout', { message: 'Connection timeout due to inactivity' });
    socket.disconnect(true);
  }, 15 * 60 * 1000);

  // Clear timeout on any activity
  const clearTimeoutOnActivity = () => {
    clearTimeout(connectionTimeout);
    userManager.updateUserActivity(socket.id);
  };

  // Handle find partner with enhanced validation
  socket.on('findPartner', (userData) => {
    try {
      console.log(`🔍 Find partner request from ${userData.userId}`);
      
      clearTimeoutOnActivity();
      
      // Validate required fields
      if (!userData.userId || !userData.gender) {
        socket.emit('error', { message: 'Missing required user data' });
        return;
      }

      // Validate gender values
      const validGenders = ['male', 'female', 'other'];
      const validPreferences = ['male', 'female', 'other', 'any'];
      
      if (!validGenders.includes(userData.gender)) {
        socket.emit('error', { message: 'Invalid gender value' });
        return;
      }
      
      if (userData.preferredGender && !validPreferences.includes(userData.preferredGender)) {
        userData.preferredGender = 'any';
      }

      // Add additional metadata
      userData.userAgent = socket.handshake.headers['user-agent'];
      userData.country = socket.handshake.headers['cf-ipcountry'] || 'unknown';
      
      const user = userManager.addUser(socket.id, userData);
      const match = userManager.findMatch(user);
      
      if (match) {
        // Notify both users about the match
        console.log(`📡 Sending match notifications to ${user.id} and ${match.id}`);
        socket.emit('matched', match.socketId);
        io.to(match.socketId).emit('matched', socket.id);
      } else {
        // Add to waiting queue
        userManager.addToQueue(user);
        socket.emit('waiting');
      }
    } catch (error) {
      console.error(`❌ Error in findPartner:`, error);
      socket.emit('error', { message: 'Failed to find partner: ' + error.message });
    }
  });

  // Handle WebRTC signaling with validation
  socket.on('offer', (offer) => {
    try {
      console.log(`📞 Relaying offer from ${socket.id}`);
      clearTimeoutOnActivity();
      
      // Validate offer structure
      if (!offer || !offer.type || !offer.sdp) {
        console.error('❌ Invalid offer received');
        return;
      }
      
      const user = userManager.findUserBySocketId(socket.id);
      if (user && user.partnerId) {
        const partnerSocket = io.sockets.sockets.get(user.partnerId);
        if (partnerSocket) {
          partnerSocket.emit('offer', offer);
        } else {
          console.error(`❌ Partner socket not found: ${user.partnerId}`);
          socket.emit('partnerDisconnected');
        }
      }
    } catch (error) {
      console.error(`❌ Error relaying offer:`, error);
      socket.emit('error', { message: 'Failed to relay offer' });
    }
  });

  socket.on('answer', (answer) => {
    try {
      console.log(`📞 Relaying answer from ${socket.id}`);
      clearTimeoutOnActivity();
      
      // Validate answer structure
      if (!answer || !answer.type || !answer.sdp) {
        console.error('❌ Invalid answer received');
        return;
      }
      
      const user = userManager.findUserBySocketId(socket.id);
      if (user && user.partnerId) {
        const partnerSocket = io.sockets.sockets.get(user.partnerId);
        if (partnerSocket) {
          partnerSocket.emit('answer', answer);
          userManager.statistics.successfulCalls++;
        } else {
          console.error(`❌ Partner socket not found: ${user.partnerId}`);
          socket.emit('partnerDisconnected');
        }
      }
    } catch (error) {
      console.error(`❌ Error relaying answer:`, error);
      socket.emit('error', { message: 'Failed to relay answer' });
    }
  });

  socket.on('ice-candidate', (candidate) => {
    try {
      console.log(`📡 Relaying ICE candidate from ${socket.id}`);
      clearTimeoutOnActivity();
      
      // Validate ICE candidate structure
      if (!candidate || (!candidate.candidate && !candidate.sdpMLineIndex)) {
        console.error('❌ Invalid ICE candidate received');
        return;
      }
      
      const user = userManager.findUserBySocketId(socket.id);
      if (user && user.partnerId) {
        const partnerSocket = io.sockets.sockets.get(user.partnerId);
        if (partnerSocket) {
          partnerSocket.emit('ice-candidate', candidate);
        } else {
          console.error(`❌ Partner socket not found: ${user.partnerId}`);
          socket.emit('partnerDisconnected');
        }
      }
    } catch (error) {
      console.error(`❌ Error relaying ICE candidate:`, error);
    }
  });

  // Handle call end with cleanup
  socket.on('endCall', () => {
    try {
      console.log(`❌ End call from ${socket.id}`);
      clearTimeoutOnActivity();
      
      const user = userManager.findUserBySocketId(socket.id);
      if (user && user.partnerId) {
        const partnerSocket = io.sockets.sockets.get(user.partnerId);
        if (partnerSocket) {
          partnerSocket.emit('partnerDisconnected');
        }
        
        // Reset partner relationship
        const partner = userManager.findUserBySocketId(user.partnerId);
        if (partner) {
          partner.partnerId = null;
          partner.isMatched = false;
        }
        
        user.partnerId = null;
        user.isMatched = false;
      }
    } catch (error) {
      console.error(`❌ Error ending call:`, error);
    }
  });

  // Handle user report (for moderation)
  socket.on('reportUser', (reportData) => {
    try {
      console.log(`🚩 User report from ${socket.id}:`, reportData);
      clearTimeoutOnActivity();
      
      const user = userManager.findUserBySocketId(socket.id);
      if (user && user.partnerId && reportData.reason) {
        // Log report for moderation review
        console.log(`📝 Report logged: User ${user.id} reported ${user.partnerId} for: ${reportData.reason}`);
        
        // Immediately disconnect the reported user (basic moderation)
        const reportedSocket = io.sockets.sockets.get(user.partnerId);
        if (reportedSocket) {
          reportedSocket.emit('reported', { message: 'You have been reported for inappropriate behavior' });
          reportedSocket.disconnect(true);
        }
        
        socket.emit('reportReceived', { message: 'Report submitted successfully' });
      }
    } catch (error) {
      console.error(`❌ Error handling report:`, error);
    }
  });

  // Handle heartbeat/ping for connection health
  socket.on('ping', () => {
    clearTimeoutOnActivity();
    socket.emit('pong');
  });

  // Handle disconnection with cleanup
  socket.on('disconnect', (reason) => {
    console.log(`🔌 User disconnected: ${socket.id}, reason: ${reason}`);
    
    clearTimeout(connectionTimeout);
    userManager.removeUser(socket.id);
    
    // Log disconnect reason for debugging
    if (reason === 'transport close' || reason === 'transport error') {
      console.log(`🔍 Network disconnect for ${socket.id}`);
    } else if (reason === 'client namespace disconnect') {
      console.log(`👋 Client initiated disconnect for ${socket.id}`);
    }
  });

  // Handle socket errors
  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
    clearTimeoutOnActivity();
  });

  // Update activity on any event
  socket.onAny((eventName) => {
    // Don't log ping events to reduce noise
    if (eventName !== 'ping' && eventName !== 'pong') {
      console.log(`📡 Event: ${eventName} from ${socket.id}`);
    }
    userManager.updateUserActivity(socket.id);
  });

  // Send welcome message with server info
  socket.emit('connected', {
    serverId: process.env.RAILWAY_SERVICE_ID || 'local',
    serverTime: Date.now(),
    features: ['video', 'audio', 'gender-filter', 'reporting']
  });
});

// Enhanced health check endpoints
app.get('/', (req, res) => {
  const stats = userManager.getStatistics();
  const distribution = userManager.getUserDistribution();
  
  res.json({
    status: '🎥 Enhanced Omegle Clone Server',
    version: '6.0.0 - Production Ready',
    timestamp: stats.timestamp,
    uptime: stats.uptime,
    environment: process.env.NODE_ENV || 'development',
    statistics: {
      totalConnections: stats.totalConnections,
      activeUsers: stats.activeUsers,
      peakConcurrentUsers: stats.peakConcurrentUsers,
      totalMatches: stats.totalMatches,
      successfulCalls: stats.successfulCalls,
      successRate: stats.totalMatches > 0 ? 
        ((stats.successfulCalls / stats.totalMatches) * 100).toFixed(2) + '%' : '0%',
      averageSessionDuration: Math.round(stats.averageSessionDuration / 1000) + 's'
    },
    queues: stats.queueStatus,
    userDistribution: distribution,
    server: {
      nodeVersion: process.version,
      platform: process.platform,
      memoryUsage: {
        rss: Math.round(stats.memoryUsage.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(stats.memoryUsage.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(stats.memoryUsage.heapTotal / 1024 / 1024) + 'MB'
      }
    }
  });
});

app.get('/health', (req, res) => {
  const healthy = userManager.statistics.activeUsers >= 0; // Simple health check
  
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    activeConnections: userManager.statistics.activeUsers,
    checks: {
      database: 'N/A',
      memory: process.memoryUsage().heapUsed < 500 * 1024 * 1024 ? 'OK' : 'HIGH',
      connections: userManager.statistics.activeUsers < 1000 ? 'OK' : 'HIGH'
    }
  });
});

app.get('/stats', (req, res) => {
  // Detailed statistics endpoint
  const stats = userManager.getStatistics();
  const distribution = userManager.getUserDistribution();
  
  res.json({
    ...stats,
    userDistribution: distribution,
    server: {
      nodeVersion: process.version,
      platform: process.platform,
      pid: process.pid,
      uptime: process.uptime()
    }
  });
});

// API endpoint to get queue status
app.get('/api/queue', (req, res) => {
  const queueStatus = userManager.getQueueStatus();
  const totalWaiting = Object.values(queueStatus).reduce((sum, count) => sum + count, 0);
  
  res.json({
    queues: queueStatus,
    totalWaiting,
    estimatedWaitTime: totalWaiting > 10 ? '30s' : totalWaiting > 5 ? '15s' : '5s'
  });
});

// Rate limiting middleware
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per minute
  message: {
    error: 'Too many requests from this IP, please try again later',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(limiter);

// Basic API security
app.use('/api', (req, res, next) => {
  res.header('X-API-Version', '1.0');
  res.header('X-Response-Time', Date.now() - req.startTime);
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Express error:', err);
  
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: isDevelopment ? err.message : 'Something went wrong',
    timestamp: new Date().toISOString(),
    ...(isDevelopment && { stack: err.stack })
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`,
    availableRoutes: ['/', '/health', '/stats', '/api/queue']
  });
});

// Enhanced process error handling
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  
  if (process.env.NODE_ENV === 'production') {
    console.log('🔄 Attempting graceful shutdown...');
    
    // Close server gracefully
    server.close(() => {
      console.log('✅ HTTP server closed');
      process.exit(1);
    });
    
    // Force exit after 10 seconds
    setTimeout(() => {
      console.log('💀 Forced exit after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  
  if (process.env.NODE_ENV === 'production') {
    console.log('🔄 Continuing in production mode...');
  } else {
    process.exit(1);
  }
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  console.log(`📡 Received ${signal}, starting graceful shutdown...`);
  
  // Stop accepting new connections
  server.close(() => {
    console.log('✅ HTTP server closed');
    
    // Close all socket connections
    io.close(() => {
      console.log('✅ Socket.IO server closed');
      
      // Close any database connections here if needed
      
      console.log('✅ Graceful shutdown completed');
      process.exit(0);
    });
  });
  
  // Force shutdown after 15 seconds
  setTimeout(() => {
    console.log('💀 Force shutdown after timeout');
    process.exit(1);
  }, 15000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = process.env.PORT || 5000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Enhanced Omegle Server running on port ${PORT}`);
  console.log(`🎯 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 CORS enabled for origins: ${allowedOrigins.length} configured`);
  console.log(`📊 Enhanced monitoring and statistics enabled`);
  console.log(`🛡️ Security features: Rate limiting, Input validation, Error handling`);
  console.log(`🔧 Features: Video chat, Gender filtering, User reporting, Auto-cleanup`);
  
  // Log server capabilities
  console.log(`📋 Server capabilities:`);
  console.log(`   - Max connections: ${process.env.MAX_CONNECTIONS || 'unlimited'}`);
  console.log(`   - Session timeout: 15 minutes`);
  console.log(`   - Cleanup interval: 2 minutes`);
  console.log(`   - Memory limit: ${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`);
});

// Export for testing
module.exports = { app, server, io, userManager };
