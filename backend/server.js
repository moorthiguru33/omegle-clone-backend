const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Enable CORS
app.use(cors());
app.use(express.json());

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 30000,
  pingInterval: 25000,
  upgradeTimeout: 10000,
  allowUpgrades: true
});

// Store active users and waiting queue
const users = new Map();
const waitingQueue = {
  male: [],
  female: [],
  other: [],
  any: []
};

// Clean up inactive users periodically
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes
  
  for (const [socketId, user] of users.entries()) {
    if (now - user.lastSeen > timeout) {
      console.log('Cleaning up inactive user:', user.id);
      removeFromQueue(user);
      users.delete(socketId);
    }
  }
}, 60000); // Check every minute

// Keep-alive to prevent Railway sleeping
const keepAlive = () => {
  setInterval(() => {
    console.log('Keep-alive ping:', new Date().toISOString(), 'Active users:', users.size);
  }, 10 * 60 * 1000); // Every 10 minutes
};
keepAlive();

// Enhanced matching logic
const findMatch = (user) => {
  let possibleMatches = [];
  
  // If user has filter credit and preferred gender
  if (user.hasFilterCredit && user.preferredGender && user.preferredGender !== 'any') {
    possibleMatches = waitingQueue[user.preferredGender] || [];
  } else {
    // Random matching from all queues
    possibleMatches = [
      ...waitingQueue.male,
      ...waitingQueue.female,
      ...waitingQueue.other,
      ...waitingQueue.any
    ];
  }
  
  // Find compatible match
  for (let i = 0; i < possibleMatches.length; i++) {
    const potentialMatch = possibleMatches[i];
    
    if (potentialMatch.id !== user.id) {
      const matchCompatible = !potentialMatch.preferredGender || 
                             potentialMatch.preferredGender === 'any' ||
                             potentialMatch.preferredGender === user.gender ||
                             !potentialMatch.hasFilterCredit;
      
      if (matchCompatible) {
        removeFromQueue(potentialMatch);
        return potentialMatch;
      }
    }
  }
  
  return null;
};

const removeFromQueue = (user) => {
  Object.keys(waitingQueue).forEach(key => {
    waitingQueue[key] = waitingQueue[key].filter(u => u.id !== user.id);
  });
};

const addToQueue = (user) => {
  if (user.gender && waitingQueue[user.gender]) {
    waitingQueue[user.gender].push(user);
  } else {
    waitingQueue.any.push(user);
  }
  console.log('Added to queue:', user.id, 'Queue sizes:', Object.keys(waitingQueue).map(k => `${k}: ${waitingQueue[k].length}`).join(', '));
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  let heartbeatInterval;
  let connectionTimeout;
  
  socket.emit('me', socket.id);
  
  // Enhanced heartbeat system
  heartbeatInterval = setInterval(() => {
    socket.emit('heartbeat', { timestamp: Date.now() });
  }, 20000);
  
  socket.on('findPartner', (userData) => {
    console.log('Find partner request:', userData);
    
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
    }
    
    const user = {
      id: userData.userId,
      socketId: socket.id,
      gender: userData.gender,
      preferredGender: userData.preferredGender,
      hasFilterCredit: userData.hasFilterCredit,
      isMobile: userData.isMobile || false,
      userAgent: userData.userAgent || '',
      connectedAt: Date.now(),
      lastSeen: Date.now()
    };
    
    users.set(socket.id, user);
    
    // Mobile timeout extended to 60 seconds
    connectionTimeout = setTimeout(() => {
      console.log('Connection timeout for user:', user.id);
      socket.emit('connectionTimeout');
      removeFromQueue(user);
    }, user.isMobile ? 60000 : 45000);
    
    // Try immediate matching
    const match = findMatch(user);
    
    if (match) {
      console.log('Match found:', user.id, 'with', match.id);
      clearTimeout(connectionTimeout);
      
      // Set partner relationships
      user.partnerId = match.id;
      match.partnerId = user.id;
      users.set(socket.id, user);
      users.set(match.socketId, match);
      
      // Staggered connection with mobile optimization
      const delay = (user.isMobile || match.isMobile) ? 2500 : 1000;
      
      setTimeout(() => {
        socket.emit('matched', match.socketId);
        io.to(match.socketId).emit('matched', socket.id);
        console.log('Sent match signals with', delay, 'ms delay');
      }, delay);
    } else {
      addToQueue(user);
      socket.emit('waiting');
    }
  });
  
  socket.on('callUser', (data) => {
    console.log('Call user:', data.userToCall, 'from:', data.from);
    io.to(data.userToCall).emit('callUser', {
      signal: data.signalData,
      from: data.from
    });
  });
  
  socket.on('answerCall', (data) => {
    console.log('Answer call to:', data.to);
    io.to(data.to).emit('callAccepted', data.signal);
  });
  
  socket.on('sendMessage', (data) => {
    const user = users.get(socket.id);
    if (user && user.partnerId) {
      const partner = Array.from(users.values()).find(u => u.id === user.partnerId);
      if (partner) {
        io.to(partner.socketId).emit('message', data);
      }
    }
  });
  
  socket.on('endCall', () => {
    console.log('End call from:', socket.id);
    const user = users.get(socket.id);
    if (user && user.partnerId) {
      const partner = Array.from(users.values()).find(u => u.id === user.partnerId);
      if (partner) {
        io.to(partner.socketId).emit('partnerDisconnected');
        delete partner.partnerId;
        users.set(partner.socketId, partner);
      }
      delete user.partnerId;
      users.set(socket.id, user);
    }
  });
  
  socket.on('heartbeat_response', () => {
    const user = users.get(socket.id);
    if (user) {
      user.lastSeen = Date.now();
      users.set(socket.id, user);
    }
  });
  
  socket.on('disconnect', (reason) => {
    console.log('User disconnected:', socket.id, 'Reason:', reason);
    
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
    }
    
    const user = users.get(socket.id);
    if (user) {
      removeFromQueue(user);
      
      // Notify partner
      if (user.partnerId) {
        const partner = Array.from(users.values()).find(u => u.id === user.partnerId);
        if (partner) {
          io.to(partner.socketId).emit('partnerDisconnected');
          delete partner.partnerId;
          users.set(partner.socketId, partner);
        }
      }
      
      users.delete(socket.id);
    }
  });
  
  socket.on('error', (error) => {
    console.error('Socket error for', socket.id, ':', error);
  });
});

// Health check endpoints
app.get('/', (req, res) => {
  const mobileUsers = Array.from(users.values()).filter(u => u.isMobile).length;
  const desktopUsers = users.size - mobileUsers;
  
  res.json({ 
    status: 'Server is running',
    activeUsers: users.size,
    mobileUsers: mobileUsers,
    desktopUsers: desktopUsers,
    waitingQueues: {
      male: waitingQueue.male.length,
      female: waitingQueue.female.length,
      other: waitingQueue.other.length,
      any: waitingQueue.any.length
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/debug', (req, res) => {
  res.json({
    connectedUsers: Array.from(users.entries()).map(([socketId, user]) => ({
      socketId,
      userId: user.id,
      isMobile: user.isMobile,
      hasPartner: !!user.partnerId,
      connectedAt: user.connectedAt,
      lastSeen: user.lastSeen,
      gender: user.gender,
      preferredGender: user.preferredGender
    })),
    waitingQueues: waitingQueue
  });
});

app.get('/ping', (req, res) => {
  res.json({ 
    pong: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Enhanced mobile signaling server running on port ${PORT}`);
  console.log('Server optimized for mobile WebRTC connections');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server terminated');
  });
});
