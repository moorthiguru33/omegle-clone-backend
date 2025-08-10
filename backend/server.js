const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// CORS configuration
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

// Statistics
const stats = {
  totalConnections: 0,
  activeUsers: 0,
  totalMatches: 0,
  successfulCalls: 0
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
};

const findMatch = (user) => {
  let potentialMatches = [];

  if (user.hasFilterCredit && user.preferredGender && user.preferredGender !== 'any') {
    potentialMatches = Array.from(waitingQueue[user.preferredGender] || []);
  } else {
    potentialMatches = [
      ...Array.from(waitingQueue.male),
      ...Array.from(waitingQueue.female),
      ...Array.from(waitingQueue.other),
      ...Array.from(waitingQueue.any)
    ];
  }

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
        return potentialMatch;
      }
    }
  }

  return null;
};

const cleanupUser = (socketId) => {
  const user = users.get(socketId);
  if (user) {
    removeFromQueue(user);
    
    if (user.partnerId) {
      const partnerConnection = Array.from(activeConnections.values())
        .find(conn => conn.userId === user.partnerId);
      
      if (partnerConnection) {
        io.to(partnerConnection.socketId).emit('partnerDisconnected');
        const partner = users.get(partnerConnection.socketId);
        if (partner) {
          delete partner.partnerId;
        }
      }
    }
    
    users.delete(socketId);
    activeConnections.delete(socketId);
    stats.activeUsers = Math.max(0, stats.activeUsers - 1);
    
    console.log(`🧹 User ${user.id} cleaned up`);
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
    
    const connection = activeConnections.get(socket.id);
    if (connection) {
      connection.userId = userData.userId;
    }

    const match = findMatch(user);
    
    if (match) {
      user.partnerId = match.id;
      match.partnerId = user.id;
      
      users.set(socket.id, user);
      users.set(match.socketId, match);
      
      console.log(`🎯 Immediate match: ${user.id} <-> ${match.id}`);
      
      // Send match notifications with proper delay
      setTimeout(() => {
        socket.emit('matched', match.socketId);
        io.to(match.socketId).emit('matched', socket.id);
        console.log(`📡 Match signals sent`);
      }, 500);
      
    } else {
      addToQueue(user);
      socket.emit('waiting');
    }
  });

  socket.on('callUser', (data) => {
    console.log(`📞 Call signal: ${data.from} -> ${data.userToCall}`);
    
    if (data.userToCall && data.signalData && data.from) {
      io.to(data.userToCall).emit('callUser', {
        signal: data.signalData,
        from: data.from,
        timestamp: Date.now()
      });
      console.log(`✅ Call signal forwarded`);
    } else {
      console.error(`❌ Invalid call data`);
    }
  });

  socket.on('answerCall', (data) => {
    console.log(`📞 Answer call: ${socket.id} -> ${data.to}`);
    
    if (data.to && data.signal) {
      io.to(data.to).emit('callAccepted', data.signal);
      stats.successfulCalls++;
      console.log(`✅ Call answer forwarded`);
    } else {
      console.error(`❌ Invalid answer data`);
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
        }
        delete user.partnerId;
      }
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 User disconnected: ${socket.id}, reason: ${reason}`);
    cleanupUser(socket.id);
  });

  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
  });
});

// Health check endpoints
app.get('/', (req, res) => {
  const queueInfo = Object.entries(waitingQueue).reduce((acc, [key, queue]) => {
    acc[key] = queue.size;
    return acc;
  }, {});

  res.json({
    status: '🎥 Enhanced Omegle Clone Server',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    stats: {
      ...stats,
      activeUsers: users.size
    },
    queues: queueInfo,
    activeConnections: activeConnections.size,
    version: '3.0.0 - Mobile Optimized'
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
    stats,
    activeConnections: activeConnections.size
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Enhanced Mobile Omegle Server running on port ${PORT}`);
  console.log(`🎯 Optimized for WebRTC mobile video calls`);
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
