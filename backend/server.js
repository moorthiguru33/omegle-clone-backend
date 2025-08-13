const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration
app.use(cors({
    origin: [
        "http://localhost:3000",
        "http://localhost:3001",
        "https://localhost:3000", 
        "https://localhost:3001",
        /^https:\/\/.*\.netlify\.app$/,
        /^https:\/\/.*\.up\.railway\.app$/,
        process.env.FRONTEND_URL
    ].filter(Boolean),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["*"]
}));

app.use(express.json());

// Socket.IO with enhanced configuration
const io = socketIo(server, {
    cors: {
        origin: [
            "http://localhost:3000",
            "http://localhost:3001",
            "https://localhost:3000",
            "https://localhost:3001", 
            /^https:\/\/.*\.netlify\.app$/,
            /^https:\/\/.*\.up\.railway\.app$/,
            process.env.FRONTEND_URL
        ].filter(Boolean),
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

// Advanced user management system
class UserManager {
    constructor() {
        this.waitingUsers = new Map();
        this.connectedUsers = new Map();
        this.activeRooms = new Map();
        this.userTimeouts = new Map();
    }

    addUser(socketId, userData) {
        console.log(`👤 Adding user: ${socketId.slice(-6)} | Gender: ${userData.gender}`);
        const user = {
            ...userData,
            socketId,
            connectedAt: Date.now(),
            status: 'connected'
        };
        this.connectedUsers.set(socketId, user);
        return user;
    }

    addToQueue(socketId, userData) {
        console.log(`⏳ Adding to queue: ${socketId.slice(-6)} | Looking for: ${userData.preferredGender}`);
        this.clearUserTimeout(socketId);
        
        const user = this.connectedUsers.get(socketId);
        if (user) {
            user.status = 'waiting';
            user.waitingSince = Date.now();
            this.waitingUsers.set(socketId, user);

            const timeoutId = setTimeout(() => {
                this.removeFromQueue(socketId);
                const socket = io.sockets.sockets.get(socketId);
                if (socket) socket.emit('queue-timeout');
            }, 120000);

            this.userTimeouts.set(socketId, timeoutId);
        }
    }

    findMatch(socketId) {
        const currentUser = this.connectedUsers.get(socketId);
        if (!currentUser) return null;

        console.log(`🔍 Finding match for: ${socketId.slice(-6)} (${currentUser.gender} looking for ${currentUser.preferredGender})`);

        for (const [partnerId, partner] of this.waitingUsers) {
            if (partnerId === socketId) continue;

            const isCompatible = this.checkCompatibility(currentUser, partner);
            
            if (isCompatible) {
                console.log(`✅ Match found: ${socketId.slice(-6)} <-> ${partnerId.slice(-6)}`);
                
                this.removeFromQueue(socketId);
                this.removeFromQueue(partnerId);
                
                const roomId = uuidv4();
                const room = {
                    id: roomId,
                    user1: currentUser,
                    user2: partner,
                    createdAt: Date.now(),
                    status: 'active'
                };
                
                this.activeRooms.set(roomId, room);
                
                currentUser.status = 'matched';
                currentUser.roomId = roomId;
                currentUser.partnerId = partnerId;
                
                partner.status = 'matched';
                partner.roomId = roomId;
                partner.partnerId = socketId;
                
                return { partner, roomId };
            }
        }
        return null;
    }

    checkCompatibility(user1, user2) {
        const user1WantsUser2 = user1.preferredGender === 'any' || user1.preferredGender === user2.gender;
        const user2WantsUser1 = user2.preferredGender === 'any' || user2.preferredGender === user1.gender;
        const user1HasCredits = user1.isPremium || (user1.preferredGender === 'any' || user1.filterCredits > 0);
        const user2HasCredits = user2.isPremium || (user2.preferredGender === 'any' || user2.filterCredits > 0);
        
        return user1WantsUser2 && user2WantsUser1 && user1HasCredits && user2HasCredits;
    }

    removeFromQueue(socketId) {
        this.waitingUsers.delete(socketId);
        this.clearUserTimeout(socketId);
        
        const user = this.connectedUsers.get(socketId);
        if (user) {
            user.status = 'connected';
            delete user.waitingSince;
        }
    }

    clearUserTimeout(socketId) {
        const timeoutId = this.userTimeouts.get(socketId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.userTimeouts.delete(socketId);
        }
    }

    disconnectUser(socketId) {
        console.log(`👋 User disconnected: ${socketId.slice(-6)}`);
        
        const user = this.connectedUsers.get(socketId);
        if (!user) return null;

        this.clearUserTimeout(socketId);
        this.removeFromQueue(socketId);
        
        let partnerId = null;
        if (user.roomId) {
            const room = this.activeRooms.get(user.roomId);
            if (room) {
                partnerId = user.partnerId;
                
                const partner = this.connectedUsers.get(partnerId);
                if (partner) {
                    delete partner.roomId;
                    delete partner.partnerId;
                    partner.status = 'connected';
                }
                
                this.activeRooms.delete(user.roomId);
            }
        }
        
        this.connectedUsers.delete(socketId);
        return partnerId;
    }

    getStats() {
        return {
            connected: this.connectedUsers.size,
            waiting: this.waitingUsers.size,
            activeRooms: this.activeRooms.size,
            timestamp: Date.now()
        };
    }
}

const userManager = new UserManager();

// Socket connection handling
io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id.slice(-6)}`);

    // User joins with profile data
    socket.on('join', (userData) => {
        try {
            console.log(`📝 User join: ${socket.id.slice(-6)}`, userData);
            
            if (!userData || !userData.userId || !userData.gender) {
                socket.emit('error', { message: 'Invalid user data' });
                return;
            }

            const user = userManager.addUser(socket.id, userData);
            socket.emit('joined', { userId: user.userId, status: 'connected' });
            
        } catch (error) {
            console.error('Join error:', error);
            socket.emit('error', { message: 'Failed to join' });
        }
    });

    // Find partner
    socket.on('find-partner', (data) => {
        try {
            console.log(`🔍 Find partner request: ${socket.id.slice(-6)}`);
            
            // Store user data first
            const user = userManager.addUser(socket.id, data);
            
            const match = userManager.findMatch(socket.id);
            
            if (match) {
                socket.emit('partner-found', {
                    partnerId: match.partner.socketId,
                    roomId: match.roomId
                });
                
                const partnerSocket = io.sockets.sockets.get(match.partner.socketId);
                if (partnerSocket) {
                    partnerSocket.emit('partner-found', {
                        partnerId: socket.id,
                        roomId: match.roomId
                    });
                }
            } else {
                userManager.addToQueue(socket.id, user);
                socket.emit('waiting', { 
                    position: userManager.waitingUsers.size,
                    estimatedWait: Math.min(userManager.waitingUsers.size * 10, 120)
                });
            }
            
        } catch (error) {
            console.error('Find partner error:', error);
            socket.emit('error', { message: 'Failed to find partner' });
        }
    });

    // WebRTC Signaling Events
    socket.on('webrtc-offer', (data) => {
        try {
            console.log(`📞 WebRTC offer: ${socket.id.slice(-6)} -> ${data.to?.slice(-6)}`);
            
            if (!data.to || !data.offer) {
                socket.emit('error', { message: 'Invalid offer data' });
                return;
            }

            const targetSocket = io.sockets.sockets.get(data.to);
            if (targetSocket) {
                targetSocket.emit('webrtc-offer', {
                    from: socket.id,
                    offer: data.offer
                });
            } else {
                socket.emit('partner-disconnected');
            }
            
        } catch (error) {
            console.error('WebRTC offer error:', error);
        }
    });

    socket.on('webrtc-answer', (data) => {
        try {
            console.log(`📱 WebRTC answer: ${socket.id.slice(-6)} -> ${data.to?.slice(-6)}`);
            
            if (!data.to || !data.answer) {
                socket.emit('error', { message: 'Invalid answer data' });
                return;
            }

            const targetSocket = io.sockets.sockets.get(data.to);
            if (targetSocket) {
                targetSocket.emit('webrtc-answer', {
                    from: socket.id,
                    answer: data.answer
                });
            } else {
                socket.emit('partner-disconnected');
            }
            
        } catch (error) {
            console.error('WebRTC answer error:', error);
        }
    });

    socket.on('webrtc-ice-candidate', (data) => {
        try {
            if (!data.to || !data.candidate) return;

            const targetSocket = io.sockets.sockets.get(data.to);
            if (targetSocket) {
                targetSocket.emit('webrtc-ice-candidate', {
                    from: socket.id,
                    candidate: data.candidate
                });
            }
            
        } catch (error) {
            console.error('WebRTC ICE candidate error:', error);
        }
    });

    // Legacy support for old event names
    socket.on('offer', (data) => {
        socket.emit('webrtc-offer', data);
    });

    socket.on('answer', (data) => {
        socket.emit('webrtc-answer', data);
    });

    socket.on('ice-candidate', (data) => {
        socket.emit('webrtc-ice-candidate', data);
    });

    // End call
    socket.on('end-call', () => {
        try {
            console.log(`📵 End call: ${socket.id.slice(-6)}`);
            
            const user = userManager.connectedUsers.get(socket.id);
            if (user && user.partnerId) {
                const partnerSocket = io.sockets.sockets.get(user.partnerId);
                if (partnerSocket) {
                    partnerSocket.emit('partner-disconnected');
                }
                
                if (user.roomId) {
                    userManager.activeRooms.delete(user.roomId);
                }
                
                delete user.roomId;
                delete user.partnerId;
                user.status = 'connected';
                
                const partner = userManager.connectedUsers.get(user.partnerId);
                if (partner) {
                    delete partner.roomId;
                    delete partner.partnerId;
                    partner.status = 'connected';
                }
            }
            
        } catch (error) {
            console.error('End call error:', error);
        }
    });

    // User disconnection
    socket.on('disconnect', (reason) => {
        try {
            console.log(`🔌 Disconnect: ${socket.id.slice(-6)} (${reason})`);
            
            const partnerId = userManager.disconnectUser(socket.id);
            
            if (partnerId) {
                const partnerSocket = io.sockets.sockets.get(partnerId);
                if (partnerSocket) {
                    partnerSocket.emit('partner-disconnected');
                }
            }
            
        } catch (error) {
            console.error('Disconnect error:', error);
        }
    });
});

// Health check endpoint
app.get('/', (req, res) => {
    const stats = userManager.getStats();
    res.json({
        status: 'Omegle Clone Server Running',
        version: '2.0.0',
        uptime: process.uptime(),
        stats,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/stats', (req, res) => {
    res.json(userManager.getStats());
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Omegle Clone Server running on port ${PORT}`);
    console.log(`📊 Stats available at: http://localhost:${PORT}/api/stats`);
});

process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

module.exports = { app, server };
