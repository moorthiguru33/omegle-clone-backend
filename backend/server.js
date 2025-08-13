const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Simple and reliable CORS
app.use(cors({
  origin: "*", // Allow all origins for testing
  credentials: true,
  methods: ["GET", "POST"],
  allowedHeaders: ["*"]
}));

app.use(express.json());

// Simple Socket.IO setup
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// Simple user management
let waitingUsers = new Map();
let connectedUsers = new Map();

// Clean and simple socket handling
io.on('connection', (socket) => {
  console.log(`New user connected: ${socket.id}`);
  
  socket.on('find-partner', (userData) => {
    console.log(`User looking for partner: ${userData.userId}`);
    
    // Store user info
    connectedUsers.set(socket.id, {
      ...userData,
      socketId: socket.id
    });
    
    // Look for available partner
    let partner = null;
    for (let [partnerId, partnerData] of waitingUsers) {
      if (partnerId !== socket.id) {
        partner = partnerData;
        waitingUsers.delete(partnerId);
        break;
      }
    }
    
    if (partner) {
      // Match found
      console.log(`Match: ${socket.id} <-> ${partner.socketId}`);
      
      socket.emit('partner-found', { partnerId: partner.socketId });
      io.to(partner.socketId).emit('partner-found', { partnerId: socket.id });
    } else {
      // Add to waiting queue
      waitingUsers.set(socket.id, {
        ...userData,
        socketId: socket.id
      });
      socket.emit('waiting');
    }
  });
  
  // WebRTC signaling
  socket.on('offer', (data) => {
    console.log(`Offer from ${socket.id} to ${data.to}`);
    io.to(data.to).emit('offer', {
      from: socket.id,
      offer: data.offer
    });
  });
  
  socket.on('answer', (data) => {
    console.log(`Answer from ${socket.id} to ${data.to}`);
    io.to(data.to).emit('answer', {
      from: socket.id,
      answer: data.answer
    });
  });
  
  socket.on('ice-candidate', (data) => {
    io.to(data.to).emit('ice-candidate', {
      from: socket.id,
      candidate: data.candidate
    });
  });
  
  socket.on('end-call', () => {
    const user = connectedUsers.get(socket.id);
    if (user && user.partnerId) {
      io.to(user.partnerId).emit('partner-disconnected');
    }
  });
  
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    waitingUsers.delete(socket.id);
    connectedUsers.delete(socket.id);
  });
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'Server running',
    users: connectedUsers.size,
    waiting: waitingUsers.size
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = { app, server };
