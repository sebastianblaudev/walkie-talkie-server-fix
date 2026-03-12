const getServerUrl = () => {
    // 1. Manually set override
    if (localStorage.getItem('walkieTalkieServer')) {
        return localStorage.getItem('walkieTalkieServer');
    }

    // 2. Network/Local Development
    const hostname = window.location.hostname;
    const port = window.location.port;

    // If we are on port 3001 (Vite/Dev), we must connect to port 3000 (Backend)
    // regardless of whether we are on 'localhost' or an IP like '172.x.x.x'
    if (port === '3001' || port === '5173') {
        return `http://${hostname}:3000`;
    }

    // 3. Fallback to current origin (Production or default)
    return window.location.origin;
};

const serverUrl = getServerUrl();
console.log("Attempting to connect to:", serverUrl);
let socket = io(serverUrl);

// --- Operation Logic ---
let currentOpId = null;
const urlParams = new URLSearchParams(window.location.search);
let opIdParam = urlParams.get('op');
let tokenParam = urlParams.get('token');

// --- Capacitor Deep Linking ---
try {
    const { App } = window.Capacitor?.Plugins || {};
    if (App && typeof App.addListener === 'function') {
        App.addListener('appUrlOpen', (event) => {
            console.log('App opened with URL:', event.url);
            try {
                const url = new URL(event.url);
                const op = url.searchParams.get('op');
                const token = url.searchParams.get('token');

                if (op && token) {
                    opIdParam = op;
                    tokenParam = token;
                    currentOpId = op;

                    if (!isPoweredOn) {
                        const startOverlay = document.getElementById('start-overlay');
                        if (startOverlay) startOverlay.click();
                    } else {
                        // Reconnect to join new operation
                        socket.disconnect();
                        socket.connect();
                    }
                }
            } catch (e) { console.error("Error parsing deep link", e); }
        });
    }
} catch (e) {
    console.warn("Capacitor App plugin not found, skipping deep link attach.");
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// --- Global Vars ---
// --- Debug ---
const debugInfo = document.createElement('div');
debugInfo.style = "position:fixed; bottom:10px; right:10px; color:#50E3C2; font-size:9px; font-family:monospace; pointer-events:none; z-index:1000; background:rgba(0,0,0,0.5); padding:5px;";
document.body.appendChild(debugInfo);
function updateDebug(msg) { debugInfo.innerText = msg; console.log("[DEBUG]", msg); }
updateDebug("Ready.");

let localStream;
let roomId;
let isPoweredOn = false;
let isSwitchingChannels = false;

// Audio Context & Nodes
let audioContext;
let micSource;
let gainNode;
let destNode;
let analyser;
let dataArray;
let canvas, canvasCtx;
let animationId;
let remoteAnalyser;
let remoteDataArray;
let remoteCanvas, remoteCanvasCtx;

// WebRTC
const peers = {};
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.ekiga.net' },
        { urls: 'stun:stun.ideasip.com' }
    ],
    iceCandidatePoolSize: 10
};

// DOM Elements
const powerBtn = document.getElementById('power-btn');
const joinBtn = document.getElementById('join-btn');
const talkBtn = document.getElementById('talk-btn');
const roomInput = document.getElementById('room-input');
const statusText = document.getElementById('status-text');
const pttContainer = document.querySelector('.ptt-wrapper');
const signalStrength = document.querySelector('.signal-icon');

// Canvas Setup
canvas = document.getElementById('visualizer');
canvasCtx = canvas.getContext('2d');
remoteCanvas = document.getElementById('remote-visualizer');
remoteCanvasCtx = remoteCanvas.getContext('2d');

// --- Socket Events ---

const opCountDisplay = document.getElementById('operator-count-display');

socket.on('channel-users-count', (count) => {
    if (opCountDisplay) {
        opCountDisplay.innerText = `${count} OPERATOR${count !== 1 ? 'S' : ''} ONLINE`;
    }
});

// Socket Connect Handler moved below joinRoom for better scoping

socket.on('operation-config', (config) => {
    console.log("Joined Operation:", config.opId);
    currentOpId = config.opId;
    statusText.innerText = `OP: ${config.opId.toUpperCase()}`;
    updateChannelUI(config.channels);

    // Auto-join default channel if not already in one
    if (config.defaultChannel && !roomId && isPoweredOn) {
        console.log("Auto-joining default channel:", config.defaultChannel);
        joinRoom(config.defaultChannel);
    }
});

function playTacticalAlert() {
    if (!audioContext) return;
    try {
        const osc = audioContext.createOscillator();
        const gainInfo = audioContext.createGain();
        osc.connect(gainInfo);
        gainInfo.connect(audioContext.destination);

        osc.type = 'square';
        osc.frequency.setValueAtTime(880, audioContext.currentTime); // A5
        osc.frequency.setValueAtTime(1108.73, audioContext.currentTime + 0.1); // C#6

        gainInfo.gain.setValueAtTime(0, audioContext.currentTime);
        gainInfo.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.02);
        gainInfo.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.4);

        osc.start(audioContext.currentTime);
        osc.stop(audioContext.currentTime + 0.5);
    } catch (e) {
        console.warn("Audio alert failed", e);
    }
}

socket.on('force-join-channel', (channelName) => {
    console.log(`Command received: Force join ${channelName}`);
    if (isPoweredOn && roomId !== channelName) {
        joinRoom(channelName);

        playTacticalAlert();

        const overlay = document.getElementById('override-overlay');
        const msg = document.getElementById('override-message');
        if (overlay && msg) {
            msg.innerText = `REROUTING TO ${channelName}...`;
            overlay.classList.remove('hidden');
            overlay.classList.add('show');

            // Hide after 3 seconds
            setTimeout(() => {
                overlay.classList.remove('show');
                setTimeout(() => overlay.classList.add('hidden'), 300); // Wait for fade out
            }, 3000);
        }

        statusText.innerText = "OVERRIDE...";
        setTimeout(() => statusText.innerText = `ID: ${userId}`, 3000); // restore
    }
});

socket.on('join-error', (msg) => {
    alert("ACCESS DENIED: " + msg);
    statusText.innerText = "ACCESS DENIED";
});

socket.on('connect_error', (err) => {
    console.error('Socket Connection Error:', err);
    statusText.innerText = "OFFLINE";
});

socket.on('disconnect', (reason) => {
    console.warn('Socket Disconnected:', reason);
    statusText.innerText = "OFFLINE";
});

// --- Channel Logic ---

function updateChannelUI(channels) {
    console.log("Allowed Channels:", channels);
    const channelSheet = document.getElementById('channel-sheet');
    const list = channelSheet.querySelector('.channel-list');

    if (list) {
        console.log("Clearing old channels and rendering:", channels.length);
        list.innerHTML = '';
        if (channels.length === 0) {
            list.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No Access to Channels</div>';
        }
        channels.forEach((ch, index) => {
            console.log(`Rendering channel ${index}:`, ch);
            const div = document.createElement('div');
            div.className = 'channel-item';
            div.setAttribute('data-channel', ch);
            div.innerHTML = `
                <div class="ch-info">
                    <span class="ch-num">#</span>
                    <span class="ch-name">${ch}</span>
                </div>
                <div class="ch-status">IDLE</div>
            `;
            div.addEventListener('click', () => {
                const newChannel = ch;
                if (newChannel === roomId) {
                    channelSheet.classList.remove('show');
                    return;
                }
                if (newChannel && isPoweredOn) {
                    if (audioContext && audioContext.state === 'suspended') audioContext.resume();
                    joinRoom(newChannel);
                    channelSheet.classList.remove('show');
                } else if (!isPoweredOn) {
                    alert("Power ON the device first!");
                    channelSheet.classList.remove('show');
                }
            });
            list.appendChild(div);
        });
    }
}

function updateChannelSelection(roomName) {
    const channelNameDisplay = document.querySelector('.channel-name');
    const channelItems = document.querySelectorAll('.channel-item');

    if (channelNameDisplay) {
        channelNameDisplay.innerHTML = roomName.replace(' ', '<br>');
    }

    channelItems.forEach(item => {
        if (item.getAttribute('data-channel') === roomName) {
            item.classList.add('active');
            item.querySelector('.ch-status').innerText = 'ONLINE';
            item.querySelector('.ch-status').style.background = 'var(--primary-color)';
            item.querySelector('.ch-status').style.color = '#000';
        } else {
            item.classList.remove('active');
            item.querySelector('.ch-status').innerText = 'IDLE';
            item.querySelector('.ch-status').style.background = 'rgba(255,255,255,0.05)';
            item.querySelector('.ch-status').style.color = 'var(--text-muted)';
        }
    });
}

function joinRoom(room) {
    if (isSwitchingChannels) return;
    isSwitchingChannels = true;
    roomId = room;

    roomInput.value = roomId;
    statusText.innerText = "TUNING...";
    joinBtn.disabled = true;
    roomInput.disabled = true;
    talkBtn.disabled = false;

    // Close WebRTC
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });

    // Reconnect Socket
    if (socket.connected) {
        socket.disconnect();
    }
    socket.connect();

    // After connect, socket.on('connect') will fire.
    // We need to ensure we join the channel room there if roomId is set.
    updateChannelSelection(room);

    // Reset flag after a short delay to allow socket reconnection
    setTimeout(() => {
        isSwitchingChannels = false;
        statusText.innerText = "ONLINE";
        console.log(`Switched to channel ${room}`);
    }, 1500);
}

// Update connect handler to join channel if roomId is set
// This handles the Reconnect case in joinRoom
const originalConnectHandler = socket.listeners('connect')[0];
socket.off('connect'); // Remove old one to replace/wrap it

socket.on('connect', () => {
    console.log('Socket Connected!', socket.id);

    // Attempt Join Operation if params exist
    if (opIdParam && tokenParam) {
        socket.emit('join-operation', {
            opId: opIdParam,
            token: tokenParam,
            userId: localStorage.getItem('walkie_user_id') || generateUUID(),
            callSign: localStorage.getItem('walkie_callsign') || 'OPERATOR'
        });
    }

    // Join Channel if set
    if (roomId && currentOpId) {
        console.log('Joining Channel Room:', roomId);
        socket.emit('join-channel', {
            opId: currentOpId,
            channelName: roomId
        });
    }
});

// --- GPS Logic ---
let watchId = null;

function startGpsTracking() {
    const uid = localStorage.getItem('walkie_user_id') || 'UNKNOWN';
    const csign = localStorage.getItem('walkie_callsign') || 'UNIT';

    // Register immediately with Op scope if exists, but server handles based on socket.OpId
    // If we are in an Op, the socket is already tagged on server side from 'join-operation'
    // But we should still emit register-unit for the record
    socket.emit('register-unit', {
        id: uid,
        callSign: csign
    });

    if ("geolocation" in navigator) {
        watchId = navigator.geolocation.watchPosition((position) => {
            const { latitude, longitude } = position.coords;
            socket.emit('update-location', {
                lat: latitude,
                lng: longitude,
                id: uid,
                callSign: csign
            });
        }, (error) => {
            console.warn("GPS Error:", error.message);
            if (error.code === 1) statusText.innerText = "NO LOCATION";
            if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
                statusText.innerText = "GPS BLOCKED";
            }
        }, {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 10000
        });
    } else {
        alert("Geolocation not supported.");
    }
}

function stopGpsTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
}

// --- Power Logic ---

function forcePowerOff() {
    isPoweredOn = false;
    statusText.innerText = "OFFLINE";
    statusText.className = "";
    joinBtn.disabled = true;
    talkBtn.disabled = true;
    pttContainer.classList.remove('transmitting', 'receiving');

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }

    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });

    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
    }

    cancelAnimationFrame(animationId);
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    // Mute gain
    if (gainNode) gainNode.gain.value = 0;

    stopGpsTracking();

    if (roomId) {
        socket.emit('leave-room', roomId);
        roomId = null;
    }
    socket.disconnect();
}

// --- Man Down Protocol Logic ---
let manDownTimer = null;
let sosCountdown = 15;
let lastMotionTime = Date.now();
const INACTIVITY_THRESHOLD = 60000; // 60 seconds
const FALL_THRESHOLD = 20; // High acceleration
let isSosActive = false;
let sosCountdownInterval = null;

const sosOverlay = document.getElementById('sos-countdown-overlay');
const sosTimerDisplay = document.getElementById('sos-timer');
const cancelSosBtn = document.getElementById('cancel-sos-btn');

function triggerManDown() {
    if (!isPoweredOn || isSosActive) return;
    isSosActive = true;
    sosCountdown = 15;

    playTacticalAlert();

    if (sosOverlay && sosTimerDisplay) {
        sosTimerDisplay.innerText = `ACTIVATING SOS IN ${sosCountdown}s`;
        sosOverlay.classList.remove('hidden');
        sosOverlay.classList.add('show');
    }

    if (navigator.vibrate) {
        navigator.vibrate([500, 200, 500, 200, 500]);
    }

    sosCountdownInterval = setInterval(() => {
        sosCountdown--;
        if (sosTimerDisplay) sosTimerDisplay.innerText = `ACTIVATING SOS IN ${sosCountdown}s`;

        if (sosCountdown <= 0) {
            clearInterval(sosCountdownInterval);
            emitSosAlert();
        }
    }, 1000);
}

if (cancelSosBtn) {
    cancelSosBtn.addEventListener('click', () => {
        isSosActive = false;
        clearInterval(sosCountdownInterval);
        if (sosOverlay) {
            sosOverlay.classList.remove('show');
            setTimeout(() => sosOverlay.classList.add('hidden'), 300);
        }
        lastMotionTime = Date.now();
    });
}

function emitSosAlert() {
    if (sosOverlay && sosTimerDisplay) {
        sosTimerDisplay.innerText = "SOS TRANSMITTED";
        setTimeout(() => {
            sosOverlay.classList.remove('show');
            setTimeout(() => sosOverlay.classList.add('hidden'), 300);
        }, 3000);
    }

    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition((position) => {
            socket.emit('sos-alert', { lat: position.coords.latitude, lng: position.coords.longitude });
        }, () => {
            socket.emit('sos-alert', { lat: 0, lng: 0 });
        });
    } else {
        socket.emit('sos-alert', { lat: 0, lng: 0 });
    }
}

window.addEventListener('devicemotion', (e) => {
    if (!isPoweredOn) return;
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;

    const magnitude = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);

    if (magnitude > FALL_THRESHOLD) {
        console.log("Significant impact detected.");
        triggerManDown();
    }

    if (Math.abs(magnitude - 9.8) > 1.0) {
        lastMotionTime = Date.now();
    }
});

setInterval(() => {
    if (!isPoweredOn || isSosActive) return;
    if (Date.now() - lastMotionTime > INACTIVITY_THRESHOLD) {
        console.log("Inactivity detected.");
        triggerManDown();
    }
}, 5000);

powerBtn.addEventListener('click', async () => {
    isPoweredOn = !isPoweredOn;
    if (isPoweredOn) {
        statusText.innerText = "INITIALIZING...";
        if (!socket.connected) socket.connect();
        startGpsTracking();

        try {
            const rawStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });

            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } else if (audioContext.state === 'suspended') {
                audioContext.resume();
            }
            micSource = audioContext.createMediaStreamSource(rawStream);
            gainNode = audioContext.createGain();
            destNode = audioContext.createMediaStreamDestination();
            analyser = audioContext.createAnalyser();

            micSource.connect(gainNode);
            gainNode.connect(destNode);
            micSource.connect(analyser);

            gainNode.gain.value = 0;
            localStream = destNode.stream;

            analyser.fftSize = 64;
            const bufferLength = analyser.frequencyBinCount;
            dataArray = new Uint8Array(bufferLength);

            drawVisualizer();
            statusText.innerText = "STANDBY";
            joinBtn.disabled = false;

            // Trigger auto-join if we already received config but weren't powered on
            const firstChannel = document.querySelector('.channel-item')?.getAttribute('data-channel');
            if (!roomId && firstChannel) { // Fallback if we don't have the config handy but UI rendered
                const chItems = document.querySelectorAll('.channel-item');
                let targetCh = firstChannel;
                chItems.forEach(i => { if (i.getAttribute('data-channel') === 'BASE') targetCh = 'BASE'; });
                joinRoom(targetCh);
            }
        } catch (err) {
            console.error("Error accessing microphone:", err);
            statusText.innerText = "MIC ERROR";
            alert("Microphone access required!");
            forcePowerOff();
        }
    } else {
        forcePowerOff();
    }
});

// --- PTT Logic ---

const startTx = () => {
    if (!isPoweredOn || !roomId || !gainNode) return;
    
    // Resume context on EVERY talk click to be 100% sure
    if (audioContext && audioContext.state === 'suspended') audioContext.resume();

    // Play a tiny tactical beep to confirm mic is live
    playTacticalAlert();

    statusText.innerText = "TRANSMITTING";
    updateDebug("TX Active");
    talkBtn.classList.add('talking');
    pttContainer.classList.add('transmitting');
    if (signalStrength) {
        const bars = signalStrength.querySelectorAll('.bar');
        bars.forEach(bar => bar.style.backgroundColor = 'var(--primary-color)');
    }
    gainNode.gain.setTargetAtTime(1, audioContext.currentTime, 0.01);
};

const stopTx = () => {
    if (!isPoweredOn || !roomId || !gainNode) return;
    statusText.innerText = "STANDBY";
    talkBtn.classList.remove('talking');
    pttContainer.classList.remove('transmitting');
    gainNode.gain.setTargetAtTime(0, audioContext.currentTime, 0.01);
};

talkBtn.addEventListener('mousedown', startTx);
window.addEventListener('mouseup', stopTx);
talkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startTx(); });
talkBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopTx(); });


// --- Visualizer Logic ---
let isReceiving = false;
const statusBar = document.querySelector('.status-bar');

function drawVisualizer() {
    if (!isPoweredOn) return;
    animationId = requestAnimationFrame(drawVisualizer);

    if (talkBtn.classList.contains('talking')) {
        analyser.getByteFrequencyData(dataArray);
        drawBars(canvas, canvasCtx, dataArray, "TX");
    }
    else if (remoteAnalyser && remoteDataArray) {
        remoteAnalyser.getByteFrequencyData(remoteDataArray);
        const sum = remoteDataArray.reduce((a, b) => a + b, 0);
        const average = sum / remoteDataArray.length;

        if (average > 10) {
            if (!isReceiving) {
                isReceiving = true;
                statusText.innerText = "RECEIVING...";
                statusBar.classList.add('receiving');
                talkBtn.classList.add('receiving');
            }
            drawBars(canvas, canvasCtx, remoteDataArray, "RX");
        } else {
            if (isReceiving) {
                isReceiving = false;
                statusText.innerText = "STANDBY";
                statusBar.classList.remove('receiving');
                talkBtn.classList.remove('receiving');
                canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
            }
        }
    } else {
        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

function drawBars(cvs, ctx, data, type) {
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    const barWidth = 6;
    const gap = 4;
    const maxBars = Math.floor(cvs.width / (barWidth + gap));
    let x = (cvs.width - (data.length * (barWidth + gap))) / 2;
    if (x < 0) x = 0;

    for (let i = 0; i < data.length; i++) {
        if (i >= 20) break;
        const value = data[i];
        const barHeight = (value / 255) * cvs.height * 0.8;
        if (barHeight < 2) continue;

        let r, g, b, shadowColor;
        if (type === "TX") {
            r = 80; g = 227; b = 194;
            shadowColor = "rgba(80, 227, 194, 0.6)";
        } else {
            r = 255; g = 159; b = 10;
            shadowColor = "rgba(255, 159, 10, 0.6)";
        }

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.shadowBlur = 15;
        ctx.shadowColor = shadowColor;
        roundRect(ctx, x, (cvs.height - barHeight) / 2, barWidth, barHeight, 3);
        x += barWidth + gap;
    }
}

function roundRect(ctx, x, y, width, height, radius) {
    if (width < 2 * radius) radius = width / 2;
    if (height < 2 * radius) radius = height / 2;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
    ctx.fill();
}

// --- WebRTC Core ---

socket.on('user-connected', (userId) => {
    console.log('User connected:', userId);
    createOffer(userId);
});

function createPeerConnection(targetId) {
    if (peers[targetId]) return peers[targetId];

    const pc = new RTCPeerConnection(rtcConfig);
    peers[targetId] = pc;

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.ontrack = (event) => {
        updateDebug(`Track Received from ${targetId}`);
        const stream = event.streams[0];
        
        let remoteAudio = document.getElementById(`audio-${targetId}`);
        if (!remoteAudio) {
            remoteAudio = new Audio();
            remoteAudio.id = `audio-${targetId}`;
            remoteAudio.autoplay = true;
            remoteAudio.playsInline = true;
            remoteAudio.style.display = 'none';
            document.body.appendChild(remoteAudio);
        }
        
        remoteAudio.srcObject = stream;
        remoteAudio.volume = 1.0;

        if (audioContext) {
            audioContext.resume().then(() => {
                try {
                    // We only connect once per session to avoid DOM errors
                    if (!remoteAudio.connectedToContext) {
                        const source = audioContext.createMediaElementSource(remoteAudio);
                        remoteAnalyser = audioContext.createAnalyser();
                        remoteAnalyser.fftSize = 64;
                        remoteDataArray = new Uint8Array(remoteAnalyser.frequencyBinCount);
                        
                        source.connect(remoteAnalyser);
                        remoteAnalyser.connect(audioContext.destination);
                        remoteAudio.connectedToContext = true;
                        updateDebug("Audio Bridged to Master");
                    }
                    remoteAudio.play();
                } catch (e) {
                    updateDebug("Bridge Error: " + e.message);
                    remoteAudio.play();
                }
            });
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: targetId,
                candidate: event.candidate
            });
        }
    };

    return pc;
}

function createOffer(targetId) {
    const pc = createPeerConnection(targetId);
    pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
            socket.emit('offer', {
                target: targetId,
                offer: pc.localDescription
            });
        });
}

socket.on('ice-candidate', (data) => {
    const pc = peers[data.caller];
    if (pc) {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate))
            .catch(e => updateDebug("ICE Error: " + e.message));
    }
});

socket.on('offer', (data) => {
    updateDebug(`Offer from ${data.caller}`);
    const pc = createPeerConnection(data.caller);
    pc.setRemoteDescription(new RTCSessionDescription(data.offer))
        .then(() => pc.createAnswer())
        .then(answer => pc.setLocalDescription(answer))
        .then(() => {
            socket.emit('answer', { target: data.caller, answer: pc.localDescription });
        })
        .catch(e => updateDebug("Offer Error: " + e.message));
});

socket.on('answer', (data) => {
    updateDebug(`Answer from ${data.caller}`);
    const pc = peers[data.caller];
    if (pc) {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer))
            .catch(e => updateDebug("Answer Error: " + e.message));
    }
});


// --- Profile & Sidebar UI Handlers ---
const navChannels = document.getElementById('nav-channels');
const closeChannelsBtn = document.getElementById('close-channels');
const channelSheet = document.getElementById('channel-sheet');

if (navChannels) navChannels.addEventListener('click', () => channelSheet.classList.add('show'));
if (closeChannelsBtn) closeChannelsBtn.addEventListener('click', () => channelSheet.classList.remove('show'));


const profileSheet = document.getElementById('profile-sheet');
const navProfile = document.getElementById('nav-profile');
const closeProfileBtn = document.getElementById('close-profile');
const disconnectBtn = document.getElementById('disconnect-btn');

// Also handle GPS toggles (kept for compatibility)
const navGps = document.getElementById('nav-gps');
const gpsPanel = document.getElementById('gps-panel');
const closeGpsBtn = document.getElementById('close-gps-sidebar');

if (navGps) navGps.addEventListener('click', () => gpsPanel.classList.add('show'));
if (closeGpsBtn) closeGpsBtn.addEventListener('click', () => gpsPanel.classList.remove('show'));


let userId = localStorage.getItem('walkie_user_id');
if (!userId) {
    userId = 'U-' + Math.floor(1000 + Math.random() * 9000);
    localStorage.setItem('walkie_user_id', userId);
}
const callSigns = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ROVER', 'EAGLE'];
let userCallSign = localStorage.getItem('walkie_callsign');
if (!userCallSign) {
    const randomName = callSigns[Math.floor(Math.random() * callSigns.length)];
    const randomNum = Math.floor(1 + Math.random() * 99).toString().padStart(2, '0');
    userCallSign = `${randomName}-${randomNum}`;
    localStorage.setItem('walkie_callsign', userCallSign);
}

if (document.getElementById('profile-id')) {
    document.getElementById('profile-id').innerText = userId;
    document.getElementById('profile-callsign').innerText = userCallSign;
}

if (navProfile) navProfile.addEventListener('click', () => profileSheet.classList.add('show'));
if (closeProfileBtn) closeProfileBtn.addEventListener('click', () => profileSheet.classList.remove('show'));

if (disconnectBtn) {
    disconnectBtn.addEventListener('click', () => {
        if (confirm('Disconnect from secure network?')) {
            forcePowerOff();
            profileSheet.classList.remove('show');
        }
    });
}
