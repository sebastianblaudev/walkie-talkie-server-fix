const getServerUrl = () => {
    // 1. Manually set override
    if (localStorage.getItem('walkieTalkieServer')) {
        return localStorage.getItem('walkieTalkieServer');
    }

    // 2. Local Development (localhost or local network IP)
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.')) {
        return window.location.origin; // e.g. http://localhost:3000
    }

    // 3. Production Fallback
    return 'https://walkie-talkie-server-fix.onrender.com';
};

const serverUrl = getServerUrl();
console.log("Attempting to connect to:", serverUrl);
let socket = io(serverUrl);

// --- Operation Logic ---
let currentOpId = null;
const urlParams = new URLSearchParams(window.location.search);
const opIdParam = urlParams.get('op');
const tokenParam = urlParams.get('token');

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// --- Global Vars ---
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
        { urls: 'stun:stun1.l.google.com:19302' }
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

// Socket Connect Handler moved below joinRoom for better scoping

socket.on('operation-config', (config) => {
    console.log("Joined Operation:", config.opId);
    currentOpId = config.opId;
    statusText.innerText = `OP: ${config.opId.toUpperCase()}`;
    updateChannelUI(config.channels);
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

            audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
    statusText.innerText = "TRANSMITTING";
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
        console.log('Received remote track');
        const remoteAudio = new Audio();
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.autoplay = true;
        remoteAudio.playsInline = true;
        remoteAudio.muted = false;

        // Attach to DOM so we can visualize it (must be played to work with WebAudio)
        // remoteAudio.play(); // Auto-play handles this but explicit encourages browser

        const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = tempCtx.createMediaElementSource(remoteAudio);
        remoteAnalyser = tempCtx.createAnalyser();
        remoteAnalyser.fftSize = 64;
        remoteDataArray = new Uint8Array(remoteAnalyser.frequencyBinCount);

        source.connect(remoteAnalyser);
        remoteAnalyser.connect(tempCtx.destination);
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

socket.on('offer', (data) => {
    const pc = createPeerConnection(data.caller);
    pc.setRemoteDescription(new RTCSessionDescription(data.offer))
        .then(() => pc.createAnswer())
        .then(answer => pc.setLocalDescription(answer))
        .then(() => {
            socket.emit('answer', {
                target: data.caller,
                answer: pc.localDescription
            });
        });
});

socket.on('answer', (data) => {
    if (peers[data.caller]) {
        peers[data.caller].setRemoteDescription(new RTCSessionDescription(data.answer));
    }
});

socket.on('ice-candidate', (data) => {
    if (peers[data.caller]) {
        peers[data.caller].addIceCandidate(new RTCIceCandidate(data.candidate));
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
