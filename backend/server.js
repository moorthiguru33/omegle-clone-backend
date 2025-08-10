const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration
app.use(cors({
  origin: ["https://your-netlify-app.netlify.app", "http://localhost:3000"],
  credentials: true
}));
app.use(express.json());

const io = socketIo(server, {
  cors: {
    origin: "*",
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
  console.log(`User ${user.id} added to ${user.preferredGender || 'any'} queue`);
  logQueueStatus();
};

const logQueueStatus = () => {
  const queueSizes = Object.entries(waitingQueue).map(([key, queue]) => 
    `${key}: ${queue.size}`
  ).join(', ');
  console.log(`Queue status: ${queueSizes}`);
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
        console.log(`Match found: ${user.id} <-> ${potentialMatch.id}`);
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
        }
      }
    }
    
    users.delete(socketId);
    activeConnections.delete(socketId);
    stats.activeUsers = Math.max(0, stats.activeUsers - 1);
    
    console.log(`User ${user.id} cleaned up. Active users: ${stats.activeUsers}`);
  }
};

// Socket connection handling
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);
  stats.totalConnections++;
  stats.activeUsers++;
  
  const connectionData = {
    socketId: socket.id,
    connectedAt: Date.now(),
    userId: null,
    lastActivity: Date.now()
  };
  
  activeConnections.set(socket.id, connectionData);

  // Heartbeat system
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
    console.log(`Find partner request from ${userData.userId}`);
    
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
      
      // Notify both users
      socket.emit('matched', match.socketId);
      io.to(match.socketId).emit('matched', socket.id);
      
      console.log(`Immediate match: ${user.id} <-> ${match.id}`);
    } else {
      // Add to waiting queue
      addToQueue(user);
      socket.emit('waiting');
    }
  });

  socket.on('callUser', (data) => {
    console.log(`Call signal: ${data.from} -> ${data.userToCall}`);
    io.to(data.userToCall).emit('callUser', {
      signal: data.signalData,
      from: data.from
    });
  });

  socket.on('answerCall', (data) => {
    console.log(`Answer call: ${socket.id} -> ${data.to}`);
    io.to(data.to).emit('callAccepted', data.signal);
  });

  socket.on('sendMessage', (data) => {
    const user = users.get(socket.id);
    if (user && user.partnerId) {
      const partner = Array.from(users.values()).find(u => u.id === user.partnerId);
      if (partner) {
        io.to(partner.socketId).emit('message', {
          text: data.text,
          timestamp: data.timestamp || Date.now()
        });
        console.log(`Message sent from ${user.id} to ${partner.id}`);
      }
    }
  });

  socket.on('endCall', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`End call from ${user.id}`);
      
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
    console.log(`User disconnected: ${socket.id}, reason: ${reason}`);
    clearInterval(heartbeat);
    cleanupUser(socket.id);
  });

  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// Health check and statistics endpoints
app.get('/', (req, res) => {
  const queueInfo = Object.entries(waitingQueue).reduce((acc, [key, queue]) => {
    acc[key] = queue.size;
    return acc;
  }, {});

  res.json({
    status: 'Omegle Clone Server Running',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    stats: {
      ...stats,
      activeUsers: users.size
    },
    queues: queueInfo,
    activeConnections: activeConnections.size
  });
});

app.get('/health', (req, res) => {
  res.json({
    healthy: true,
    timestamp: new Date().toISOString(),
    activeUsers: users.size,
    uptime: process.uptime()
  });
});

// Cleanup inactive connections
setInterval(() => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000; // 10 minutes

  for (const [socketId, connection] of activeConnections.entries()) {
    if (now - connection.lastActivity > timeout) {
      console.log(`Cleaning up inactive connection: ${socketId}`);
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
    uptime: process.uptime() 
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Omegle Clone Server running on port ${PORT}`);
  console.log(`📊 Health check available at: http://localhost:${PORT}/`);
  console.log(`🎯 Environment: ${process.env.NODE_ENV || 'development'}`);
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
