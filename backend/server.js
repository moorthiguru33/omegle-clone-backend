const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration for Railway + Netlify
app.use(cors({
    origin: [
        "https://lambent-biscuit-2313da.netlify.app",  // Your actual Netlify URL
        "http://localhost:3000",
        "https://*.netlify.app",
        "https://netlify.app"
    ],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["*"]
}));

app.use(express.json());
app.use(express.static('public'));

// Socket.IO with comprehensive configuration
const io = socketIo(server, {
    cors: {
        origin: [
            "https://lambent-biscuit-2313da.netlify.app",  // Your actual Netlify URL
            "http://localhost:3000",
            "https://*.netlify.app"
        ],
        methods: ["GET", "POST"],
        credentials: true,
        allowEIO3: true
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    upgradeTimeout: 30000,
    maxHttpBufferSize: 1e6
});

// Enhanced data structures for user management
class UserManager {
    constructor() {
        this.waitingQueue = new Map();
        this.activeConnections = new Map();
        this.userSessions = new Map();
        this.roomPairs = new Map();
    }

    // Add user to waiting queue
    addToQueue(socketId, userData) {
        this.waitingQueue.set(socketId, {
            ...userData,
            socketId,
            timestamp: Date.now(),
            queuePosition: this.waitingQueue.size + 1
        });
        
        this.userSessions.set(socketId, {
            socketId,
            ...userData,
            connectedAt: Date.now(),
            status: 'waiting'
        });
    }

    // Find compatible partner
    findCompatiblePartner(userData) {
        for (let [socketId, waitingUser] of this.waitingQueue) {
            if (socketId === userData.socketId) continue;
            
            // Check gender preferences
            const userWants = userData.preferredGender || 'any';
            const partnerWants = waitingUser.preferredGender || 'any';
            const userGender = userData.gender;
            const partnerGender = waitingUser.gender;
            
            // Compatibility check
            const userCompatible = userWants === 'any' || userWants === partnerGender;
            const partnerCompatible = partnerWants === 'any' || partnerWants === userGender;
            
            if (userCompatible && partnerCompatible) {
                return waitingUser;
            }
        }
        return null;
    }

    // Create room pair
    createRoom(user1Id, user2Id) {
        const roomId = uuidv4();
        this.activeConnections.set(user1Id, user2Id);
        this.activeConnections.set(user2Id, user1Id);
        this.roomPairs.set(roomId, { user1: user1Id, user2: user2Id });
        
        // Remove from queue
        this.waitingQueue.delete(user1Id);
        this.waitingQueue.delete(user2Id);
        
        // Update session status
        if (this.userSessions.has(user1Id)) {
            this.userSessions.get(user1Id).status = 'connected';
        }
        if (this.userSessions.has(user2Id)) {
            this.userSessions.get(user2Id).status = 'connected';
        }
        
        return roomId;
    }

    // Get partner ID
    getPartnerId(socketId) {
        return this.activeConnections.get(socketId);
    }

    // Clean up user data
    cleanupUser(socketId) {
        const partnerId = this.activeConnections.get(socketId);
        
        // Clean up partner connection
        if (partnerId) {
            this.activeConnections.delete(partnerId);
        }
        
        // Clean up user data
        this.activeConnections.delete(socketId);
        this.waitingQueue.delete(socketId);
        this.userSessions.delete(socketId);
        
        // Clean up room pairs
        for (let [roomId, room] of this.roomPairs) {
            if (room.user1 === socketId || room.user2 === socketId) {
                this.roomPairs.delete(roomId);
                break;
            }
        }
        
        return partnerId;
    }

    // Get stats
    getStats() {
        return {
            activeConnections: this.activeConnections.size / 2, // Divide by 2 since each connection is stored twice
            waitingQueue: this.waitingQueue.size,
            totalSessions: this.userSessions.size,
            activeRooms: this.roomPairs.size
        };
    }
}

// Initialize user manager
const userManager = new UserManager();

// Logging utility
const log = (message, data = null) => {
    const timestamp = new Date().toISOString();
    if (data) {
        console.log(`[${timestamp}] ${message}:`, data);
    } else {
        console.log(`[${timestamp}] ${message}`);
    }
};

// Socket connection handling
io.on('connection', (socket) => {
    log(`✅ New connection`, { socketId: socket.id, address: socket.handshake.address });
    
    // Handle partner search - supporting both event names for compatibility
    socket.on('find-partner', handleFindPartner);
    socket.on('findPartner', handleFindPartner);
    
    function handleFindPartner(userData) {
        try {
            log(`🔍 Partner search request`, { 
                socketId: socket.id, 
                userId: userData.userId,
                gender: userData.gender,
                preferredGender: userData.preferredGender 
            });
            
            // Validate user data
            if (!userData || !userData.userId || !userData.gender) {
                socket.emit('error', { message: 'Invalid user data' });
                return;
            }
            
            // Clean any existing connections
            const oldPartnerId = userManager.cleanupUser(socket.id);
            if (oldPartnerId) {
                io.to(oldPartnerId).emit('partnerDisconnected');
                log(`🧹 Cleaned up existing connection`, { oldPartnerId });
            }
            
            const userInfo = {
                ...userData,
                socketId: socket.id,
                timestamp: Date.now()
            };
            
            // Look for compatible partner
            const partner = userManager.findCompatiblePartner(userInfo);
            
            if (partner) {
                // Match found - create room
                const roomId = userManager.createRoom(socket.id, partner.socketId);
                
                log(`🎯 Match created`, { 
                    roomId,
                    user1: socket.id, 
                    user2: partner.socketId,
                    user1Gender: userData.gender,
                    user2Gender: partner.gender
                });
                
                // Notify both users with enhanced data
                const matchData = {
                    partnerId: partner.socketId,
                    roomId: roomId,
                    partnerGender: partner.gender
                };
                
                const partnerMatchData = {
                    partnerId: socket.id,
                    roomId: roomId,
                    partnerGender: userData.gender
                };
                
                socket.emit('matched', matchData);
                io.to(partner.socketId).emit('matched', partnerMatchData);
                
            } else {
                // Add to waiting queue
                userManager.addToQueue(socket.id, userInfo);
                const stats = userManager.getStats();
                
                socket.emit('waiting', { 
                    position: userManager.waitingQueue.get(socket.id).queuePosition,
                    totalWaiting: stats.waitingQueue
                });
                
                log(`⏳ Added to queue`, { 
                    socketId: socket.id, 
                    queueSize: stats.waitingQueue,
                    position: userManager.waitingQueue.get(socket.id).queuePosition
                });
            }
            
        } catch (error) {
            log(`❌ Error in find partner`, { error: error.message, socketId: socket.id });
            socket.emit('error', { message: 'Failed to find partner' });
        }
    }

    // WebRTC signaling events with enhanced logging
    socket.on('offer', (data) => {
        try {
            const partnerId = userManager.getPartnerId(socket.id);
            if (partnerId && io.sockets.sockets.get(partnerId)) {
                io.to(partnerId).emit('offer', data);
                log(`📞 Offer relayed`, { from: socket.id, to: partnerId });
            } else {
                log(`❌ Offer failed - no partner`, { from: socket.id });
                socket.emit('partnerDisconnected');
            }
        } catch (error) {
            log(`❌ Offer error`, { error: error.message, socketId: socket.id });
        }
    });

    socket.on('answer', (data) => {
        try {
            const partnerId = userManager.getPartnerId(socket.id);
            if (partnerId && io.sockets.sockets.get(partnerId)) {
                io.to(partnerId).emit('answer', data);
                log(`✅ Answer relayed`, { from: socket.id, to: partnerId });
            } else {
                log(`❌ Answer failed - no partner`, { from: socket.id });
                socket.emit('partnerDisconnected');
            }
        } catch (error) {
            log(`❌ Answer error`, { error: error.message, socketId: socket.id });
        }
    });

    socket.on('ice-candidate', (data) => {
        try {
            const partnerId = userManager.getPartnerId(socket.id);
            if (partnerId && io.sockets.sockets.get(partnerId)) {
                io.to(partnerId).emit('ice-candidate', data);
                // Reduced logging for ICE candidates to prevent spam
                // log(`📡 ICE candidate relayed`, { from: socket.id, to: partnerId });
            }
        } catch (error) {
            log(`❌ ICE candidate error`, { error: error.message, socketId: socket.id });
        }
    });

    // Call management
    socket.on('endCall', () => {
        try {
            const partnerId = userManager.cleanupUser(socket.id);
            if (partnerId) {
                io.to(partnerId).emit('partnerDisconnected');
                log(`📞 Call ended`, { by: socket.id, partner: partnerId });
            }
        } catch (error) {
            log(`❌ End call error`, { error: error.message, socketId: socket.id });
        }
    });

    // Ping/pong for connection health
    socket.on('ping', () => {
        socket.emit('pong');
    });

    // Connection monitoring
    socket.on('disconnect', (reason) => {
        try {
            const partnerId = userManager.cleanupUser(socket.id);
            if (partnerId) {
                io.to(partnerId).emit('partnerDisconnected');
            }
            log(`❌ User disconnected`, { socketId: socket.id, reason, partner: partnerId });
        } catch (error) {
            log(`❌ Disconnect cleanup error`, { error: error.message, socketId: socket.id });
        }
    });

    // Error handling
    socket.on('error', (error) => {
        log(`❌ Socket error`, { socketId: socket.id, error: error.message });
    });
});

// Health check and API endpoints
app.get('/', (req, res) => {
    const stats = userManager.getStats();
    res.json({
        status: 'Omegle Clone Server Running',
        version: '3.0.0',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        environment: process.env.NODE_ENV || 'development',
        stats: {
            ...stats,
            memoryUsage: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
            }
        }
    });
});

app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString() 
    });
});

app.get('/stats', (req, res) => {
    const stats = userManager.getStats();
    res.json({
        ...stats,
        timestamp: new Date().toISOString(),
        connectedSockets: io.sockets.sockets.size
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    log(`❌ Express error`, { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Server startup
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    log(`🚀 Server started`, {
        port: PORT,
        host: HOST,
        environment: process.env.NODE_ENV || 'development',
        nodeVersion: process.version,
        cors: 'https://lambent-biscuit-2313da.netlify.app'
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    log('🔄 SIGTERM received, shutting down gracefully');
    server.close(() => {
        log('💀 Process terminated');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    log('🔄 SIGINT received, shutting down gracefully');
    server.close(() => {
        log('💀 Process terminated');
        process.exit(0);
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    log('❌ Uncaught Exception', { error: error.message, stack: error.stack });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log('❌ Unhandled Rejection', { reason, promise });
});

module.exports = { app, server, userManager };
