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
  }
});

// Store active users and waiting queue
const users = new Map();
const waitingQueue = {
  male: [],
  female: [],
  other: [],
  any: []
};

// User matching logic
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
  
  // Find a match that isn't the same user and has compatible preferences
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
  
  socket.on('findPartner', (userData) => {
    const user = {
      id: userData.userId,
      socketId: socket.id,
      gender: userData.gender,
      preferredGender: userData.preferredGender,
      hasFilterCredit: userData.hasFilterCredit
    };
    
    users.set(socket.id, user);
    
    // Try to find a match
    const match = findMatch(user);
    
    if (match) {
      // Found a match
      console.log('Match found:', user.id, 'with', match.id);
      
      socket.emit('matched', match.id);
      io.to(match.socketId).emit('matched', user.id);
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
        delete partner.partnerId;
      }
      delete user.partnerId;
    }
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    const user = users.get(socket.id);
    if (user) {
      // Remove from queue
      removeFromQueue(user);
      
      // Notify partner if in call
      if (user.partnerId) {
        const partner = Array.from(users.values()).find(u => u.id === user.partnerId);
        if (partner) {
          io.to(partner.socketId).emit('partnerDisconnected');
        }
      }
      
      users.delete(socket.id);
    }
  });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Server is running',
    activeUsers: users.size,
    waitingQueues: {
      male: waitingQueue.male.length,
      female: waitingQueue.female.length,
      other: waitingQueue.other.length,
      any: waitingQueue.any.length
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
