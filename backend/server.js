const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// CORS configuration with your Netlify URL
app.use(cors({
  origin: [
    "https://lambent-biscuit-2313da.netlify.app",
    "http://localhost:3000"
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization"]
}));

app.use(express.json());

const io = socketIo(server, {
  cors: {
    origin: [
      "https://lambent-biscuit-2313da.netlify.app",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  allowUpgrades: true,
  transports: ['websocket', 'polling']
});

// Enhanced data structures
const users = new Map();
const waitingQueue = {
  male: new Set(),
  female: new Set(),
  other: new Set(),
  any: new Set()
};

const activeConnections = new Map();
const activeMatches = new Map(); // Track active video matches

// Statistics tracking
const stats = {
  totalConnections: 0,
  activeUsers: 0,
  totalMatches: 0,
  avgConnectionTime: 0
};

// Utility functions
const removeFromQueue = (user) => {
  Object.values(waitingQueue).forEach(queue => {
    queue.delete(user);
  });
};

const addToQueue = (user) => {
  const queue = user.preferredGender && waitingQueue[user.preferredGender] 
    ? waitingQueue[user.preferredGender] 
    : waitingQueue.any;
  
  queue.add(user);
  console.log(`✅ User ${user.id} added to ${user.preferredGender || 'any'} queue`);
  logQueueStatus();
};

const logQueueStatus = () => {
  const queueSizes = Object.entries(waitingQueue).map(([key, queue]) => 
    `${key}: ${queue.size}`
  ).join(', ');
  console.log(`📊 Queue status: ${queueSizes}`);
};

const findMatch = (user) => {
  let potentialMatches = [];

  // Priority matching based on preferences
  if (user.hasFilterCredit && user.preferredGender && user.preferredGender !== 'any') {
    potentialMatches = Array.from(waitingQueue[user.preferredGender] || []);
  } else {
    // Combine all queues for random matching
    potentialMatches = [
      ...Array.from(waitingQueue.male),
      ...Array.from(waitingQueue.female),
      ...Array.from(waitingQueue.other),
      ...Array.from(waitingQueue.any)
    ];
  }

  // Find compatible match
  for (const potentialMatch of potentialMatches) {
    if (potentialMatch.id !== user.id) {
      const isCompatible = !potentialMatch.preferredGender ||
                          potentialMatch.preferredGender === 'any' ||
                          potentialMatch.preferredGender === user.gender ||
                          !potentialMatch.hasFilterCredit;

      if (isCompatible) {
        removeFromQueue(potentialMatch);
        stats.totalMatches++;
        console.log(`🎯 Match found: ${user.id} <-> ${potentialMatch.id}`);
        
        // Track active match
        activeMatches.set(user.id, potentialMatch.id);
        activeMatches.set(potentialMatch.id, user.id);
        
        return potentialMatch;
      }
    }
  }

  return null;
};

// Enhanced cleanup
const cleanupUser = (socketId) => {
  const user = users.get(socketId);
  if (user) {
    removeFromQueue(user);
    
    // Notify partner if connected
    if (user.partnerId) {
      const partnerConnection = Array.from(activeConnections.values())
        .find(conn => conn.userId === user.partnerId);
      
      if (partnerConnection) {
        io.to(partnerConnection.socketId).emit('partnerDisconnected');
        // Remove partner relationship
        const partner = users.get(partnerConnection.socketId);
        if (partner) {
          delete partner.partnerId;
          activeMatches.delete(partner.id);
        }
      }
      
      // Clean up active match
      activeMatches.delete(user.id);
    }
    
    users.delete(socketId);
    activeConnections.delete(socketId);
    stats.activeUsers = Math.max(0, stats.activeUsers - 1);
    
    console.log(`🧹 User ${user.id} cleaned up. Active users: ${stats.activeUsers}`);
  }
};

// Socket connection handling
io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);
  stats.totalConnections++;
  stats.activeUsers++;
  
  const connectionData = {
    socketId: socket.id,
    connectedAt: Date.now(),
    userId: null,
    lastActivity: Date.now()
  };
  
  activeConnections.set(socket.id, connectionData);

  // Enhanced heartbeat system
  const heartbeat = setInterval(() => {
    socket.emit('ping');
  }, 30000);

  socket.on('pong', () => {
    const connection = activeConnections.get(socket.id);
    if (connection) {
      connection.lastActivity = Date.now();
    }
  });

  socket.on('findPartner', (userData) => {
    console.log(`🔍 Find partner request from ${userData.userId}`);
    
    const user = {
      id: userData.userId,
      socketId: socket.id,
      gender: userData.gender,
      preferredGender: userData.preferredGender,
      hasFilterCredit: userData.hasFilterCredit,
      joinedAt: Date.now()
    };

    users.set(socket.id, user);
    
    // Update connection data
    const connection = activeConnections.get(socket.id);
    if (connection) {
      connection.userId = userData.userId;
    }

    // Try to find immediate match
    const match = findMatch(user);
    
    if (match) {
      // Create partner relationship
      user.partnerId = match.id;
      match.partnerId = user.id;
      
      users.set(socket.id, user);
      users.set(match.socketId, match);
      
      console.log(`🎯 Immediate match: ${user.id} <-> ${match.id}`);
      
      // Send match notifications with delay for better WebRTC setup
      setTimeout(() => {
        socket.emit('matched', match.socketId);
        io.to(match.socketId).emit('matched', socket.id);
        console.log(`📡 Match signals sent`);
      }, 1000);
      
    } else {
      // Add to waiting queue
      addToQueue(user);
      socket.emit('waiting');
    }
  });

  socket.on('callUser', (data) => {
    console.log(`📞 Call signal: ${data.from} -> ${data.userToCall}`);
    
    // Enhanced call handling with validation
    const callingUser = users.get(socket.id);
    const targetSocket = data.userToCall;
    
    if (callingUser && targetSocket) {
      io.to(targetSocket).emit('callUser', {
        signal: data.signalData,
        from: data.from,
        timestamp: Date.now()
      });
      
      console.log(`✅ Call signal forwarded to ${targetSocket}`);
    } else {
      console.error(`❌ Invalid call data:`, data);
    }
  });

  socket.on('answerCall', (data) => {
    console.log(`📞 Answer call: ${socket.id} -> ${data.to}`);
    
    // Enhanced answer handling with validation
    if (data.to && data.signal) {
      io.to(data.to).emit('callAccepted', data.signal);
      console.log(`✅ Call answer forwarded to ${data.to}`);
    } else {
      console.error(`❌ Invalid answer data:`, data);
    }
  });

  socket.on('sendMessage', (data) => {
    const user = users.get(socket.id);
    if (user && user.partnerId) {
      const partner = Array.from(users.values()).find(u => u.id === user.partnerId);
      if (partner) {
        io.to(partner.socketId).emit('message', {
          text: data.text,
          timestamp: data.timestamp || Date.now(),
          from: user.id
        });
        console.log(`💬 Message sent from ${user.id} to ${partner.id}`);
      }
    }
  });

  socket.on('endCall', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`❌ End call from ${user.id}`);
      
      if (user.partnerId) {
        const partner = Array.from(users.values()).find(u => u.id === user.partnerId);
        if (partner) {
          io.to(partner.socketId).emit('partnerDisconnected');
          delete partner.partnerId;
          activeMatches.delete(partner.id);
        }
        delete user.partnerId;
        activeMatches.delete(user.id);
      }
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 User disconnected: ${socket.id}, reason: ${reason}`);
    clearInterval(heartbeat);
    cleanupUser(socket.id);
  });

  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
  });
});

// Health check and statistics endpoints
app.get('/', (req, res) => {
  const queueInfo = Object.entries(waitingQueue).reduce((acc, [key, queue]) => {
    acc[key] = queue.size;
    return acc;
  }, {});

  res.json({
    status: '🎥 Omegle Clone Server Running',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    stats: {
      ...stats,
      activeUsers: users.size,
      activeMatches: activeMatches.size / 2
    },
    queues: queueInfo,
    activeConnections: activeConnections.size,
    version: '2.1.0',
    features: [
      'WebRTC Video Chat',
      'Gender Filtering', 
      'Text Messaging',
      'Partner Matching',
      'Mobile Support'
    ]
  });
});

app.get('/debug', (req, res) => {
  res.json({
    connectedUsers: Array.from(users.entries()).map(([socketId, user]) => ({
      socketId,
      userId: user.id,
      hasPartner: !!user.partnerId,
      connectedAt: user.joinedAt,
      gender: user.gender,
      preferredGender: user.preferredGender
    })),
    waitingQueues: Object.entries(waitingQueue).reduce((acc, [key, queue]) => {
      acc[key] = Array.from(queue).map(u => ({
        id: u.id,
        gender: u.gender,
        preferredGender: u.preferredGender
      }));
      return acc;
    }, {}),
    activeMatches: Array.from(activeMatches.entries())
  });
});

// Cleanup inactive connections
setInterval(() => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000; // 10 minutes

  for (const [socketId, connection] of activeConnections.entries()) {
    if (now - connection.lastActivity > timeout) {
      console.log(`🧹 Cleaning up inactive connection: ${socketId}`);
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.disconnect(true);
      }
      cleanupUser(socketId);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// Railway health check
app.get('/ping', (req, res) => {
  res.json({ 
    pong: true, 
    timestamp: Date.now(),
    uptime: process.uptime(),
    server: 'Railway Enhanced'
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Enhanced Omegle Clone Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/`);
  console.log(`🎯 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 CORS enabled for: https://lambent-biscuit-2313da.netlify.app`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server terminated');
    process.exit(0);
  });
});
