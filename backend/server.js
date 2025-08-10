const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration
const allowedOrigins = [
  "https://lambent-biscuit-2313da.netlify.app",
  "http://localhost:3000",
  "https://localhost:3000",
  /\.netlify\.app$/,
  /localhost:\d+$/
];

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
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization"]
}));

app.use(express.json());

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
      peakConcurrentUsers: 0
    };
  }

  addUser(socketId, userData) {
    const user = {
      id: userData.userId,
      socketId: socketId,
      gender: userData.gender,
      preferredGender: userData.preferredGender,
      hasFilterCredit: userData.hasFilterCredit,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      isMatched: false,
      partnerId: null
    };
    
    this.users.set(socketId, user);
    this.statistics.activeUsers = this.users.size;
    this.statistics.peakConcurrentUsers = Math.max(
      this.statistics.peakConcurrentUsers, 
      this.statistics.activeUsers
    );
    
    console.log(`✅ User ${user.id} added. Active users: ${this.statistics.activeUsers}`);
    return user;
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
    if (user.isMatched) return;
    
    // Remove from all queues first
    this.removeFromQueue(user);
    
    // Add to appropriate queue
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

    for (const [socketId, user] of this.users) {
      if (now - user.lastActivity > inactivityThreshold) {
        console.log(`🧹 Cleaning up inactive user: ${user.id}`);
        this.removeUser(socketId);
        io.to(socketId).disconnect(true);
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
      timestamp: new Date().toISOString()
    };
  }
}

const userManager = new UserManager();

// Cleanup inactive users every 2 minutes
setInterval(() => {
  userManager.cleanupInactiveUsers();
}, 2 * 60 * 1000);

// Enhanced socket connection handling
io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);
  userManager.statistics.totalConnections++;
  
  // Store connection info
  userManager.activeConnections.set(socket.id, {
    socketId: socket.id,
    connectedAt: Date.now(),
    lastActivity: Date.now()
  });

  // Set connection timeout
  const connectionTimeout = setTimeout(() => {
    console.log(`⏰ Connection timeout for ${socket.id}`);
    socket.disconnect(true);
  }, 5 * 60 * 1000); // 5 minutes

  // Handle find partner
  socket.on('findPartner', (userData) => {
    try {
      console.log(`🔍 Find partner request from ${userData.userId}`);
      
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
      socket.emit('error', { message: 'Failed to find partner' });
    }
  });

  // Handle WebRTC signaling
  socket.on('offer', (offer) => {
    try {
      console.log(`📞 Relaying offer from ${socket.id}`);
      userManager.updateUserActivity(socket.id);
      
      const user = userManager.findUserBySocketId(socket.id);
      if (user && user.partnerId) {
        io.to(user.partnerId).emit('offer', offer);
      }
    } catch (error) {
      console.error(`❌ Error relaying offer:`, error);
    }
  });

  socket.on('answer', (answer) => {
    try {
      console.log(`📞 Relaying answer from ${socket.id}`);
      userManager.updateUserActivity(socket.id);
      
      const user = userManager.findUserBySocketId(socket.id);
      if (user && user.partnerId) {
        io.to(user.partnerId).emit('answer', answer);
        userManager.statistics.successfulCalls++;
      }
    } catch (error) {
      console.error(`❌ Error relaying answer:`, error);
    }
  });

  socket.on('ice-candidate', (candidate) => {
    try {
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

// Enhanced health check endpoints
app.get('/', (req, res) => {
  const stats = userManager.getStatistics();
  
  res.json({
    status: '🎥 Enhanced Omegle Clone Server',
    version: '5.0.0 - Production Ready',
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
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage()
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime())
  });
});

app.get('/stats', (req, res) => {
  const stats = userManager.getStatistics();
  res.json(stats);
});

// Enhanced error handling
app.use((err, req, res, next) => {
  console.error('❌ Express error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  if (process.env.NODE_ENV === 'production') {
    console.log('📝 Continuing in production mode...');
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

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Enhanced Omegle Server running on port ${PORT}`);
  console.log(`🎯 Production-ready with advanced features`);
  console.log(`🌐 CORS enabled for multiple origins`);
  console.log(`📊 Enhanced monitoring and statistics`);
  console.log(`🛡️ Improved error handling and resilience`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  server.close(() => {
    console.log('✅ HTTP server closed');
    
    io.close(() => {
      console.log('✅ Socket.IO server closed');
      process.exit(0);
    });
  });
  
  setTimeout(() => {
    console.log('⏰ Force closing after timeout');
    process.exit(1);
  }, 10000);
});

module.exports = { app, server, io, userManager };
