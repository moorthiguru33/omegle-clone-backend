import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import styled from 'styled-components';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
  font-family: 'Arial', sans-serif;
  position: relative;
  overflow: hidden;
`;

const VideoContainer = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  flex: 1;
  gap: 2px;
  padding: 10px;
  
  @media (max-width: 768px) {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
`;

const VideoWrapper = styled.div`
  position: relative;
  background: #000;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
`;

const Video = styled.video`
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 12px;
  -webkit-playsinline: true;
  playsinline: true;
`;

const VideoLabel = styled.div`
  position: absolute;
  top: 12px;
  left: 12px;
  background: rgba(0, 0, 0, 0.8);
  color: white;
  padding: 6px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  z-index: 10;
`;

const StatusBar = styled.div`
  position: absolute;
  top: 20px;
  right: 20px;
  background: ${props => {
    if (props.status === 'Connected!') return 'rgba(34, 197, 94, 0.9)';
    if (props.status.includes('Connecting') || props.status.includes('Finding')) return 'rgba(251, 191, 36, 0.9)';
    return 'rgba(239, 68, 68, 0.9)';
  }};
  color: white;
  padding: 8px 16px;
  border-radius: 25px;
  font-size: 14px;
  font-weight: 600;
  z-index: 1000;
`;

const Controls = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 20px;
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(20px);
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  gap: 16px;
  flex-wrap: wrap;
`;

const ControlButton = styled.button`
  width: 56px;
  height: 56px;
  border: none;
  border-radius: 50%;
  font-size: 20px;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  touch-action: manipulation;
  
  &.primary {
    background: linear-gradient(45deg, #ef4444, #dc2626);
    color: white;
    box-shadow: 0 4px 20px rgba(239, 68, 68, 0.4);
  }
  
  &.secondary {
    background: linear-gradient(45deg, #10b981, #059669);
    color: white;
    box-shadow: 0 4px 20px rgba(16, 185, 129, 0.4);
  }
  
  &.control {
    background: ${props => props.active
      ? 'linear-gradient(45deg, #6366f1, #4f46e5)'
      : 'rgba(255, 255, 255, 0.2)'};
    color: white;
    border: 2px solid ${props => props.active ? '#6366f1' : 'rgba(255, 255, 255, 0.3)'};
  }
  
  &.home {
    background: rgba(107, 114, 128, 0.8);
    color: white;
    border: 2px solid rgba(107, 114, 128, 0.6);
  }
  
  &:hover:not(:disabled) {
    transform: translateY(-2px);
  }
  
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const PlaceholderMessage = styled.div`
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  color: rgba(255, 255, 255, 0.8);
  font-size: 18px;
  font-weight: 500;
  z-index: 5;
`;

// Get backend URL dynamically
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'https://omegle-clone-backend-production-8f06.up.railway.app';

// Enhanced ICE servers
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject', 
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

const VideoChat = ({ user, updateUser }) => {
  const navigate = useNavigate();
  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const socketRef = useRef();
  const peerConnectionRef = useRef();
  const timeoutsRef = useRef({});
  
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [status, setStatus] = useState('Initializing...');
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [partnerId, setPartnerId] = useState(null);

  // Clear all timeouts
  const clearTimeouts = useCallback(() => {
    Object.values(timeoutsRef.current).forEach(clearTimeout);
    timeoutsRef.current = {};
  }, []);

  // Initialize media
  const initializeMedia = useCallback(async () => {
    try {
      setStatus('Getting camera...');
      
      const constraints = {
        video: {
          width: { min: 240, ideal: 640, max: 1280 },
          height: { min: 180, ideal: 480, max: 720 },
          frameRate: { min: 15, ideal: 24, max: 30 },
          facingMode: 'user'
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setLocalStream(stream);
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        localVideoRef.current.playsInline = true;
        await localVideoRef.current.play().catch(() => {});
      }
      
      return stream;
    } catch (error) {
      console.error('Media error:', error);
      setStatus('Camera access failed');
      throw error;
    }
  }, []);

  // Initialize socket
  const initializeSocket = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    setStatus('Connecting to server...');
    
    socketRef.current = io(BACKEND_URL, {
      transports: ['websocket', 'polling'],
      timeout: 20000,
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000
    });

    // Connection events
    socketRef.current.on('connect', () => {
      console.log('✅ Connected to server');
      setStatus('Connected! Finding partner...');
      
      // Start partner search
      socketRef.current.emit('find-partner', {
        userId: user.id,
        gender: user.gender,
        preferredGender: user.preferredGender || 'any',
        filterCredits: user.filterCredits || 0,
        isPremium: user.isPremium || false
      });
    });

    socketRef.current.on('disconnect', () => {
      setStatus('Server disconnected');
      clearTimeouts();
    });

    socketRef.current.on('connect_error', () => {
      setStatus('Connection failed');
    });

    // Partner matching
    socketRef.current.on('waiting', (data) => {
      setStatus(`Waiting for partner... (${data?.position || 0} in queue)`);
    });

    socketRef.current.on('partner-found', ({ partnerId: foundPartnerId, roomId }) => {
      console.log('🎯 Partner found:', foundPartnerId);
      setStatus('Partner found! Starting call...');
      setPartnerId(foundPartnerId);
      
      // Small delay before starting call
      timeoutsRef.current.callStart = setTimeout(() => {
        createOffer(foundPartnerId);
      }, 1000);
    });

    // WebRTC signaling
    socketRef.current.on('webrtc-offer', async ({ from, offer }) => {
      console.log('📞 Received offer from:', from);
      setStatus('Incoming call...');
      setPartnerId(from);
      await handleOffer(from, offer);
    });

    socketRef.current.on('webrtc-answer', async ({ from, answer }) => {
      console.log('✅ Received answer from:', from);
      setStatus('Connecting...');
      await handleAnswer(answer);
    });

    socketRef.current.on('webrtc-ice-candidate', ({ from, candidate }) => {
      handleIceCandidate(candidate);
    });

    socketRef.current.on('partner-disconnected', () => {
      console.log('👋 Partner disconnected');
      setStatus('Partner disconnected. Finding new partner...');
      cleanup();
      
      timeoutsRef.current.newPartner = setTimeout(() => {
        socketRef.current?.emit('find-partner', {
          userId: user.id,
          gender: user.gender,
          preferredGender: user.preferredGender || 'any',
          filterCredits: user.filterCredits || 0,
          isPremium: user.isPremium || false
        });
      }, 2000);
    });
  }, [user]);

  // Create peer connection
  const createPeerConnection = useCallback((targetId) => {
    console.log('🔗 Creating peer connection');
    
    const config = {
      iceServers: ICE_SERVERS,
      sdpSemantics: 'unified-plan',
      iceCandidatePoolSize: 10
    };

    const pc = new RTCPeerConnection(config);

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        console.log('📡 Sending ICE candidate');
        socketRef.current.emit('webrtc-ice-candidate', {
          to: targetId,
          candidate: event.candidate
        });
      }
    };

    pc.ontrack = (event) => {
      console.log('🎬 Received remote stream');
      const [stream] = event.streams;
      setRemoteStream(stream);
      setStatus('Connected!');
      
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
        remoteVideoRef.current.playsInline = true;
        remoteVideoRef.current.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('🔗 Connection state:', pc.connectionState);
      
      switch (pc.connectionState) {
        case 'connected':
          setStatus('Connected!');
          clearTimeouts();
          break;
        case 'disconnected':
        case 'failed':
          setStatus('Connection lost. Finding new partner...');
          cleanup();
          timeoutsRef.current.retry = setTimeout(() => findNewPartner(), 3000);
          break;
        case 'connecting':
          setStatus('Connecting...');
          break;
      }
    };

    return pc;
  }, []);

  // Create and send offer
  const createOffer = useCallback(async (targetId) => {
    if (!localStream) return;

    try {
      console.log('📞 Creating offer for:', targetId);
      peerConnectionRef.current = createPeerConnection(targetId);
      
      // Add local stream
      localStream.getTracks().forEach(track => {
        peerConnectionRef.current.addTrack(track, localStream);
      });

      const offer = await peerConnectionRef.current.createOffer();
      await peerConnectionRef.current.setLocalDescription(offer);

      socketRef.current.emit('webrtc-offer', {
        to: targetId,
        offer
      });

      // Set timeout
      timeoutsRef.current.offerTimeout = setTimeout(() => {
        setStatus('Connection timeout. Finding new partner...');
        findNewPartner();
      }, 15000);

    } catch (error) {
      console.error('Failed to create offer:', error);
      findNewPartner();
    }
  }, [localStream, createPeerConnection]);

  // Handle incoming offer
  const handleOffer = useCallback(async (from, offer) => {
    if (!localStream) return;

    try {
      console.log('📞 Handling offer from:', from);
      peerConnectionRef.current = createPeerConnection(from);
      
      // Add local stream
      localStream.getTracks().forEach(track => {
        peerConnectionRef.current.addTrack(track, localStream);
      });

      await peerConnectionRef.current.setRemoteDescription(offer);
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);

      socketRef.current.emit('webrtc-answer', {
        to: from,
        answer
      });

    } catch (error) {
      console.error('Failed to handle offer:', error);
      findNewPartner();
    }
  }, [localStream, createPeerConnection]);

  // Handle answer
  const handleAnswer = useCallback(async (answer) => {
    if (!peerConnectionRef.current) return;

    try {
      await peerConnectionRef.current.setRemoteDescription(answer);
      console.log('✅ Answer processed');
    } catch (error) {
      console.error('Failed to handle answer:', error);
    }
  }, []);

  // Handle ICE candidate
  const handleIceCandidate = useCallback(async (candidate) => {
    if (!peerConnectionRef.current) return;

    try {
      await peerConnectionRef.current.addIceCandidate(candidate);
      console.log('📡 ICE candidate added');
    } catch (error) {
      console.error('ICE candidate error:', error);
    }
  }, []);

  // Find new partner
  const findNewPartner = useCallback(() => {
    cleanup();
    setStatus('Finding new partner...');
    
    if (socketRef.current?.connected) {
      socketRef.current.emit('find-partner', {
        userId: user.id,
        gender: user.gender,
        preferredGender: user.preferredGender || 'any',
        filterCredits: user.filterCredits || 0,
        isPremium: user.isPremium || false
      });
    }
  }, [user]);

  // Cleanup connections
  const cleanup = useCallback(() => {
    clearTimeouts();
    
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    setRemoteStream(null);
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    
    setPartnerId(null);
  }, [clearTimeouts]);

  // Control functions
  const toggleAudio = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioEnabled;
        setAudioEnabled(!audioEnabled);
      }
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoEnabled;
        setVideoEnabled(!videoEnabled);
      }
    }
  };

  const nextPartner = () => {
    if (socketRef.current) {
      socketRef.current.emit('end-call');
    }
    findNewPartner();
  };

  const endCall = () => {
    if (socketRef.current) {
      socketRef.current.emit('end-call');
      socketRef.current.disconnect();
    }
    
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    
    cleanup();
    navigate('/');
  };

  // Initialize on mount
  useEffect(() => {
    if (!user?.id || !user?.gender) {
      navigate('/');
      return;
    }

    const init = async () => {
      try {
        await initializeMedia();
        initializeSocket();
      } catch (error) {
        console.error('Initialization failed:', error);
        setStatus('Initialization failed');
      }
    };

    init();

    return () => {
      clearTimeouts();
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [user, navigate, initializeMedia, initializeSocket, localStream, clearTimeouts]);

  return (
    <Container>
      <StatusBar status={status}>{status}</StatusBar>
      
      <VideoContainer>
        <VideoWrapper>
          <VideoLabel>You</VideoLabel>
          <Video ref={localVideoRef} autoPlay muted playsInline />
          {!localStream && (
            <PlaceholderMessage>🎥 Starting camera...</PlaceholderMessage>
          )}
        </VideoWrapper>
        
        <VideoWrapper>
          <VideoLabel>Partner</VideoLabel>
          <Video ref={remoteVideoRef} autoPlay playsInline />
          {!remoteStream && (
            <PlaceholderMessage>
              {partnerId ? '🔄 Connecting...' : '👋 Waiting for partner...'}
            </PlaceholderMessage>
          )}
        </VideoWrapper>
      </VideoContainer>
      
      <Controls>
        <ControlButton 
          className="control" 
          active={audioEnabled}
          onClick={toggleAudio}
        >
          {audioEnabled ? '🎤' : '🔇'}
        </ControlButton>
        
        <ControlButton 
          className="control"
          active={videoEnabled} 
          onClick={toggleVideo}
        >
          {videoEnabled ? '📹' : '📷'}
        </ControlButton>
        
        <ControlButton className="secondary" onClick={nextPartner}>
          ⏭️
        </ControlButton>
        
        <ControlButton className="primary" onClick={endCall}>
          📵
        </ControlButton>
        
        <ControlButton className="home" onClick={() => navigate('/')}>
          🏠
        </ControlButton>
      </Controls>
    </Container>
  );
};

export default VideoChat;
