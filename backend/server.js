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
  pingTimeout: 60000,
  pingInterval: 25000
});

// Store active users and waiting queue
const users = new Map();
const waitingQueue = {
  male: [],
  female: [],
  other: [],
  any: []
};

// Enhanced matching logic for mobile devices
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
  
  // Find a match with mobile connection timeout consideration
  for (let i = 0; i < possibleMatches.length; i++) {
    const potentialMatch = possibleMatches[i];
    
    if (potentialMatch.id !== user.id) {
      // Check if the match is compatible
      const matchCompatible = !potentialMatch.preferredGender || 
                             potentialMatch.preferredGender === 'any' ||
                             potentialMatch.preferredGender === user.gender ||
                             !potentialMatch.hasFilterCredit;
      
      if (matchCompatible) {
        // Remove from queue
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
  // Add to appropriate queue based on gender
  if (user.gender && waitingQueue[user.gender]) {
    waitingQueue[user.gender].push(user);
  } else {
    waitingQueue.any.push(user);
  }
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.emit('me', socket.id);
  
  // Mobile connection timeout (45 seconds for mobile, 30 for desktop)
  let connectionTimeout;
  
  socket.on('findPartner', (userData) => {
    const user = {
      id: userData.userId,
      socketId: socket.id,
      gender: userData.gender,
      preferredGender: userData.preferredGender,
      hasFilterCredit: userData.hasFilterCredit,
      isMobile: userData.isMobile || false,
      connectedAt: Date.now()
    };
    
    users.set(socket.id, user);
    
    // Clear any existing timeout
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
    }
    
    // Set mobile-optimized timeout
    connectionTimeout = setTimeout(() => {
      socket.emit('connectionTimeout');
      removeFromQueue(user);
    }, user.isMobile ? 45000 : 30000);
    
    // Try to find a match immediately
    const match = findMatch(user);
    
    if (match) {
      console.log('Match found:', user.id, 'with', match.id);
      clearTimeout(connectionTimeout);
      
      // Store partner IDs for later reference
      user.partnerId = match.id;
      match.partnerId = user.id;
      users.set(match.socketId, match);
      
      // Add delay for mobile connection establishment
      const delay = user.isMobile || match.isMobile ? 1500 : 200;
      
      setTimeout(() => {
        socket.emit('matched', match.socketId);
        io.to(match.socketId).emit('matched', socket.id);
      }, delay);
    } else {
      // No match found, add to waiting queue
      addToQueue(user);
      socket.emit('waiting');
      console.log('User added to queue:', user.id);
    }
  });
  
  socket.on('callUser', (data) => {
    console.log('Call user:', data.userToCall);
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
    const user = users.get(socket.id);
    if (user && user.partnerId) {
      const partner = Array.from(users.values()).find(u => u.id === user.partnerId);
      if (partner) {
        io.to(partner.socketId).emit('partnerDisconnected');
        // Clean up partner references
        delete partner.partnerId;
        users.set(partner.socketId, partner);
      }
      delete user.partnerId;
      users.set(socket.id, user);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Clear timeout
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
    }
    
    const user = users.get(socket.id);
    if (user) {
      // Remove from queue
      removeFromQueue(user);
      
      // Notify partner if in call
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
  
  // Handle connection errors
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Health check endpoint with mobile-specific stats
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
    uptime: process.uptime()
  });
});

// Additional endpoint for debugging
app.get('/debug', (req, res) => {
  res.json({
    connectedUsers: Array.from(users.entries()).map(([socketId, user]) => ({
      socketId,
      userId: user.id,
      isMobile: user.isMobile,
      hasPartner: !!user.partnerId,
      connectedAt: user.connectedAt
    }))
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Mobile-optimized signaling server ready');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});
