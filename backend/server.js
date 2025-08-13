const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration for production
const allowedOrigins = [
  "https://lambent-biscuit-2313da.netlify.app",
  "http://localhost:3000",
  "https://localhost:3000",
  /\.netlify\.app$/,
  /localhost:\d+$/,
  // Add your custom domain here
  /yourdomain\.com$/
];

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
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization"]
}));

app.use(express.json({ limit: '10mb' }));

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

// Rate limiting store (simple in-memory, use Redis in production)
const rateLimitStore = new Map();

// Rate limiting middleware
const rateLimit = (socketId, limit = 10, windowMs = 60000) => {
  const now = Date.now();
  const windowStart = now - windowMs;
  
  if (!rateLimitStore.has(socketId)) {
    rateLimitStore.set(socketId, []);
  }
  
  const requests = rateLimitStore.get(socketId);
  
  // Remove old requests outside the window
  const recentRequests = requests.filter(time => time > windowStart);
  
  if (recentRequests.length >= limit) {
    return false; // Rate limit exceeded
  }
  
  recentRequests.push(now);
  rateLimitStore.set(socketId, recentRequests);
  return true;
};

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
      startTime: Date.now()
    };
    this.blockedUsers = new Set();
  }

  // Input validation
  validateUserData(userData) {
    if (!userData || typeof userData !== 'object') {
      throw new Error('Invalid user data');
    }
    
    const { userId, gender, preferredGender } = userData;
    
    if (!userId || typeof userId !== 'string' || userId.length > 50) {
      throw new Error('Invalid user ID');
    }
    
    const validGenders = ['male', 'female', 'other'];
    if (!gender || !validGenders.includes(gender)) {
      throw new Error('Invalid gender');
    }
    
    const validPreferences = ['male', 'female', 'other', 'any'];
    if (preferredGender && !validPreferences.includes(preferredGender)) {
      throw new Error('Invalid gender preference');
    }
    
    return true;
  }

  addUser(socketId, userData) {
    try {
      this.validateUserData(userData);
      
      // Check if user is blocked
      if (this.blockedUsers.has(userData.userId)) {
        throw new Error('User is blocked');
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
        matchAttempts: 0
      };

      this.users.set(socketId, user);
      this.statistics.activeUsers = this.users.size;
      this.statistics.peakConcurrentUsers = Math.max(
        this.statistics.peakConcurrentUsers,
        this.statistics.activeUsers
      );

      console.log(`✅ User ${user.id} added. Active users: ${this.statistics.activeUsers}`);
      return user;
    } catch (error) {
      console.error('Error adding user:', error);
      throw error;
    }
  }

  removeUser(socketId) {
    const user = this.users.get(socketId);
    if (!user) return null;

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

  findUserBySocketId(socketId) {
    return this.users.get(socketId);
  }

  addToQueue(user) {
    if (user.isMatched || user.matchAttempts > 10) return;

    // Remove from all queues first
    this.removeFromQueue(user);

    // Determine target queue
    let targetQueue = 'any';
    if (user.hasFilterCredit && user.preferredGender && user.preferredGender !== 'any') {
      targetQueue = user.preferredGender;
    }

    if (this.waitingQueue[targetQueue]) {
      this.waitingQueue[targetQueue].add(user);
      console.log(`📥 User ${user.id} added to ${targetQueue} queue (size: ${this.waitingQueue[targetQueue].size})`);
    }
  }

  removeFromQueue(user) {
    Object.values(this.waitingQueue).forEach(queue => {
      queue.delete(user);
    });
  }

  findMatch(user) {
    if (user.isMatched || user.matchAttempts > 10) return null;

    user.matchAttempts++;

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

      for (const potentialMatch of queue) {
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
          user.matchedAt = Date.now();

          potentialMatch.isMatched = true;
          potentialMatch.partnerId = user.socketId;
          potentialMatch.matchedAt = Date.now();

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
    
    // Prevent same user from being matched multiple times
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
    const inactivityThreshold = 10 * 60 * 1000; // 10 minutes
    const usersToCleanup = [];

    for (const [socketId, user] of this.users) {
      if (now - user.lastActivity > inactivityThreshold) {
        usersToCleanup.push(socketId);
      }
    }

    for (const socketId of usersToCleanup) {
      console.log(`🧹 Cleaning up inactive user: ${socketId}`);
      this.removeUser(socketId);
      
      // Try to disconnect the socket
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.disconnect(true);
      }
    }

    // Clean up rate limit store
    const rateLimitThreshold = 5 * 60 * 1000; // 5 minutes
    for (const [socketId, requests] of rateLimitStore.entries()) {
      const recentRequests = requests.filter(time => now - time < rateLimitThreshold);
      if (recentRequests.length === 0) {
        rateLimitStore.delete(socketId);
      } else {
        rateLimitStore.set(socketId, recentRequests);
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
    const uptime = Math.floor((Date.now() - this.statistics.startTime) / 1000);
    return {
      ...this.statistics,
      queueStatus: this.getQueueStatus(),
      uptime: uptime,
      timestamp: new Date().toISOString(),
      memoryUsage: process.memoryUsage(),
      version: '6.0.0'
    };
  }

  blockUser(userId) {
    this.blockedUsers.add(userId);
    console.log(`🚫 User ${userId} blocked`);
  }

  unblockUser(userId) {
    this.blockedUsers.delete(userId);
    console.log(`✅ User ${userId} unblocked`);
  }
}

const userManager = new UserManager();

// Cleanup inactive users every 5 minutes
setInterval(() => {
  userManager.cleanupInactiveUsers();
}, 5 * 60 * 1000);

// Enhanced socket connection handling
io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id} from ${socket.handshake.address}`);
  userManager.statistics.totalConnections++;

  // Store connection info
  userManager.activeConnections.set(socket.id, {
    socketId: socket.id,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
    ip: socket.handshake.address
  });

  // Set connection timeout
  const connectionTimeout = setTimeout(() => {
    console.log(`⏰ Connection timeout for ${socket.id}`);
    socket.disconnect(true);
  }, 10 * 60 * 1000); // 10 minutes

  // Handle find partner with rate limiting and validation
  socket.on('findPartner', (userData) => {
    try {
      // Rate limiting
      if (!rateLimit(socket.id, 5, 30000)) { // 5 requests per 30 seconds
        socket.emit('error', { message: 'Too many requests. Please wait.' });
        return;
      }

      console.log(`🔍 Find partner request from ${userData?.userId}`);
      clearTimeout(connectionTimeout);
      userManager.updateUserActivity(socket.id);

      const user = userManager.addUser(socket.id, userData);
      const match = userManager.findMatch(user);

      if (match) {
        // Notify both users
        console.log(`📡 Sending match notifications`);
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
      if (!offer || typeof offer !== 'object') {
        throw new Error('Invalid offer data');
      }

      if (!rateLimit(socket.id, 10, 60000)) {
        return;
      }

      console.log(`📞 Relaying offer from ${socket.id}`);
      userManager.updateUserActivity(socket.id);
      const user = userManager.findUserBySocketId(socket.id);

      if (user && user.partnerId) {
        io.to(user.partnerId).emit('offer', offer);
      }

    } catch (error) {
      console.error(`❌ Error relaying offer:`, error);
      socket.emit('error', { message: 'Failed to relay offer' });
    }
  });

  socket.on('answer', (answer) => {
    try {
      if (!answer || typeof answer !== 'object') {
        throw new Error('Invalid answer data');
      }

      if (!rateLimit(socket.id, 10, 60000)) {
        return;
      }

      console.log(`📞 Relaying answer from ${socket.id}`);
      userManager.updateUserActivity(socket.id);
      const user = userManager.findUserBySocketId(socket.id);

      if (user && user.partnerId) {
        io.to(user.partnerId).emit('answer', answer);
        userManager.statistics.successfulCalls++;
      }

    } catch (error) {
      console.error(`❌ Error relaying answer:`, error);
      socket.emit('error', { message: 'Failed to relay answer' });
    }
  });

  socket.on('ice-candidate', (candidate) => {
    try {
      if (!candidate || typeof candidate !== 'object') {
        throw new Error('Invalid ICE candidate data');
      }

      if (!rateLimit(socket.id, 20, 60000)) {
        return;
      }

      console.log(`📡 Relaying ICE candidate from ${socket.id}`);
      userManager.updateUserActivity(socket.id);
      const user = userManager.findUserBySocketId(socket.id);

      if (user && user.partnerId) {
        io.to(user.partnerId).emit('ice-candidate', candidate);
      }

    } catch (error) {
      console.error(`❌ Error relaying ICE candidate:`, error);
    }
  });

  // Handle call end
  socket.on('endCall', () => {
    try {
      if (!rateLimit(socket.id, 10, 60000)) {
        return;
      }

      console.log(`❌ End call from ${socket.id}`);
      userManager.updateUserActivity(socket.id);
      const user = userManager.findUserBySocketId(socket.id);

      if (user && user.partnerId) {
        io.to(user.partnerId).emit('partnerDisconnected');

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

  // Handle report user
  socket.on('reportUser', (reportData) => {
    try {
      if (!rateLimit(socket.id, 3, 60000)) { // 3 reports per minute
        return;
      }

      console.log(`🚨 User report from ${socket.id}:`, reportData);
      // Here you would implement your reporting logic
      // For now, just log it
      socket.emit('reportReceived', { message: 'Report received. Thank you.' });

    } catch (error) {
      console.error(`❌ Error handling report:`, error);
    }
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log(`🔌 User disconnected: ${socket.id}, reason: ${reason}`);
    clearTimeout(connectionTimeout);
    userManager.removeUser(socket.id);
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
    userManager.updateUserActivity(socket.id);
  });

  // Update activity on any event
  socket.onAny(() => {
    userManager.updateUserActivity(socket.id);
  });
});

// Enhanced API endpoints
app.get('/', (req, res) => {
  const stats = userManager.getStatistics();
  res.json({
    status: '🎥 Enhanced Omegle Clone Server',
    version: '6.0.0 - Production Ready',
    timestamp: stats.timestamp,
    uptime: stats.uptime,
    statistics: {
      totalConnections: stats.totalConnections,
      activeUsers: stats.activeUsers,
      peakConcurrentUsers: stats.peakConcurrentUsers,
      totalMatches: stats.totalMatches,
      successfulCalls: stats.successfulCalls,
      successRate: stats.totalMatches > 0 ?
        ((stats.successfulCalls / stats.totalMatches) * 100).toFixed(2) + '%' : '0%'
    },
    queues: stats.queueStatus,
    performance: {
      memoryUsage: stats.memoryUsage,
      cpuUsage: process.cpuUsage()
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: '6.0.0'
  });
});

app.get('/stats', (req, res) => {
  const stats = userManager.getStatistics();
  res.json(stats);
});

// Admin endpoint (protect this in production)
app.post('/admin/block-user', (req, res) => {
  const { userId, adminKey } = req.body;
  
  // Simple admin key check (use proper authentication in production)
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID required' });
  }
  
  userManager.blockUser(userId);
  res.json({ success: true, message: `User ${userId} blocked` });
});

// Enhanced error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Express error:', err);
  
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: isDevelopment ? err.message : 'Something went wrong',
    ...(isDevelopment && { stack: err.stack })
  });
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: 'The requested resource was not found'
  });
});

// Enhanced process error handling
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  
  if (process.env.NODE_ENV === 'production') {
    console.log('📝 Continuing in production mode...');
    // In production, you might want to restart the process
    // process.exit(1);
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  
  if (process.env.NODE_ENV === 'production') {
    console.log('📝 Continuing in production mode...');
  }
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  console.log(`\n${signal} received, starting graceful shutdown...`);
  
  // Stop accepting new connections
  server.close(() => {
    console.log('✅ HTTP server closed');
    
    // Close all socket connections
    io.close(() => {
      console.log('✅ Socket.IO server closed');
      
      // Clean up resources
      userManager.users.clear();
      rateLimitStore.clear();
      
      console.log('✅ Graceful shutdown completed');
      process.exit(0);
    });
  });
  
  // Force close after timeout
  setTimeout(() => {
    console.log('⏰ Force closing after timeout');
    process.exit(1);
  }, 15000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Enhanced Omegle Server v6.0.0 running on port ${PORT}`);
  console.log(`🎯 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 CORS enabled for multiple origins`);
  console.log(`📊 Enhanced monitoring and statistics`);
  console.log(`🛡️ Improved security and error handling`);
  console.log(`⚡ Rate limiting enabled`);
  console.log(`🔧 Input validation enabled`);
});

module.exports = { app, server, io, userManager };
