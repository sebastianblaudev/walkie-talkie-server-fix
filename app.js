// Clear old manual URL once to ensure the new default takes effect
if (localStorage.getItem('walkieTalkieServer') && localStorage.getItem('walkieTalkieServer').includes('localhost')) {
    localStorage.removeItem('walkieTalkieServer');
}

const getServerUrl = () => {
    return localStorage.getItem('walkieTalkieServer') || 'https://walkie-talkie-remote.onrender.com';
};

const serverUrl = getServerUrl();
console.log("Attempting to connect to:", serverUrl);
let socket = io(serverUrl);

socket.on('connect', () => {
    console.log('Socket Connected!', socket.id);
    statusText.innerText = "SERVER OK"; // Visual feedback
});

socket.on('connect_error', (err) => {
    console.error('Socket Connection Error:', err);
    statusText.innerText = "SERVER ERROR";
});

socket.on('disconnect', (reason) => {
    console.warn('Socket Disconnected:', reason);
    statusText.innerText = "OFFLINE";
});

document.getElementById('server-config-btn').addEventListener('click', () => {
    const newUrl = prompt('Enter Server URL (e.g., http://192.168.1.50:3000):', getServerUrl());
    if (newUrl) {
        localStorage.setItem('walkieTalkieServer', newUrl);
        window.location.reload();
    }
});
let localStream; // This will now be the PROCESSED stream (dest.stream)
let roomId;
let isPoweredOn = false;

// Audio Context & Nodes
let audioContext;
let micSource;  // Raw microphone source
let gainNode;   // Controls volume (PTT)
let destNode;   // Destination node (feeds PeerConnection)
let analyser;   // For Visualizer
let dataArray;
let canvas, canvasCtx;
let animationId;
let remoteAnalyser;
let remoteDataArray;
let remoteCanvas, remoteCanvasCtx;

// WebRTC
const peers = {}; // userId -> RTCPeerConnection
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
};

// DOM Elements
const powerBtn = document.getElementById('power-btn');
const joinBtn = document.getElementById('join-btn');
const talkBtn = document.getElementById('talk-btn');
const roomInput = document.getElementById('room-input');
const statusText = document.getElementById('status-text');
const currentChannel = document.getElementById('current-channel');
const pttContainer = document.querySelector('.ptt-container');
const signalStrength = document.querySelector('.signal-strength');
const brandLogo = document.querySelector('.brand-logo');

// Canvas Setup
canvas = document.getElementById('visualizer');
canvas = document.getElementById('visualizer');
canvasCtx = canvas.getContext('2d');
remoteCanvas = document.getElementById('remote-visualizer');
remoteCanvasCtx = remoteCanvas.getContext('2d');

// Power Button Logic
powerBtn.addEventListener('click', async () => {
    isPoweredOn = !isPoweredOn;
    if (isPoweredOn) {
        powerBtn.classList.add('active');
        statusText.innerText = "INITIALIZING...";
        brandLogo.style.textShadow = "0 0 20px var(--neon-cyan)";

        try {
            // 1. Get Raw Microphone Stream
            const rawStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });

            // 2. Initialize Audio Context
            audioContext = new (window.AudioContext || window.webkitAudioContext)();

            // 3. Create Nodes
            micSource = audioContext.createMediaStreamSource(rawStream);
            gainNode = audioContext.createGain();
            destNode = audioContext.createMediaStreamDestination();
            analyser = audioContext.createAnalyser();

            // 4. Connect Graph for Transmission (Mic -> Gain -> Dest)
            micSource.connect(gainNode);
            gainNode.connect(destNode);

            // 5. Connect Graph for Visualization (Mic -> Analyser)
            // We connect Mic directly so we see visualizer even when NOT transmitting (for UX feedback)
            // Or we could connect gainNode depending on preference. Let's do Mic for "Device Active" feel.
            micSource.connect(analyser);

            // 6. Set Initial State (Muted)
            gainNode.gain.value = 0;

            // 7. This is the stream we will add to WebRTC
            localStream = destNode.stream;

            // Visualizer Setup
            analyser.fftSize = 256;
            const bufferLength = analyser.frequencyBinCount;
            dataArray = new Uint8Array(bufferLength);

            // Remote Visualizer Setup (Mock if not yet connected, but ready)
            if (!remoteAnalyser) {
                // created in ontrack usually, but let's init vars
            }

            drawVisualizer();

            statusText.innerText = "STANDBY";
            signalStrength.classList.add('active');
            joinBtn.disabled = false;
        } catch (err) {
            console.error("Error accessing microphone:", err);
            alert("Microphone access required!");
            forcePowerOff();
        }
    } else {
        forcePowerOff();
    }
});

function forcePowerOff() {
    isPoweredOn = false;
    powerBtn.classList.remove('active');
    statusText.innerText = "OFFLINE";
    statusText.className = "";
    currentChannel.innerText = "--";
    joinBtn.disabled = true;
    talkBtn.disabled = true;
    signalStrength.classList.remove('active');
    pttContainer.classList.remove('transmitting', 'receiving');

    // Stop all tracks (both raw mic and destination)
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }

    // Close connections
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });

    // Close AudioContext
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
    }

    cancelAnimationFrame(animationId);
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
}

// Join Room Logic
joinBtn.addEventListener('click', () => {
    if (!isPoweredOn) return;
    const room = roomInput.value.trim();
    if (room) {
        roomId = room;
        socket.emit('join-room', roomId);
        currentChannel.innerText = roomId;
        statusText.innerText = "CONNECTED";
        statusText.classList.add('connected');
        joinBtn.disabled = true;
        roomInput.disabled = true;
        talkBtn.disabled = false;
    }
});

// Push-to-Talk Logic
const startTx = () => {
    if (!isPoweredOn || !roomId || !gainNode) return;
    statusText.innerText = "TRANSMITTING";
    statusText.className = "transmitting";
    talkBtn.classList.add('talking');
    pttContainer.classList.add('transmitting');

    // Unmute smoothly
    gainNode.gain.setTargetAtTime(1, audioContext.currentTime, 0.01);
};

const stopTx = () => {
    if (!isPoweredOn || !roomId || !gainNode) return;
    statusText.innerText = "CONNECTED";
    statusText.className = "connected";
    talkBtn.classList.remove('talking');
    pttContainer.classList.remove('transmitting');

    // Mute smoothly
    gainNode.gain.setTargetAtTime(0, audioContext.currentTime, 0.01);
};

// Desktop
talkBtn.addEventListener('mousedown', startTx);
window.addEventListener('mouseup', stopTx);
// Mobile
talkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startTx(); });
talkBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopTx(); });


// Audio Visualizer Logic
function drawVisualizer() {
    if (!isPoweredOn) return;
    animationId = requestAnimationFrame(drawVisualizer);

    // --- Local (TX) ---
    analyser.getByteFrequencyData(dataArray);
    drawBars(canvas, canvasCtx, dataArray, "TX");

    // --- Remote (RX) ---
    if (remoteAnalyser && remoteDataArray) {
        remoteAnalyser.getByteFrequencyData(remoteDataArray);
        drawBars(remoteCanvas, remoteCanvasCtx, remoteDataArray, "RX");
    } else {
        // Clear remote if silence
        remoteCanvasCtx.clearRect(0, 0, remoteCanvas.width, remoteCanvas.height);
    }
}

function drawBars(cvs, ctx, data, type) {
    ctx.fillStyle = '#050f14';
    ctx.clearRect(0, 0, cvs.width, cvs.height);

    const barWidth = (cvs.width / data.length) * 2.5;
    let barHeight;
    let x = 0;

    for (let i = 0; i < data.length; i++) {
        barHeight = data[i] / 2;

        // Color Scheme
        let r, g, b;
        if (type === "TX") {
            // Cyan/Blue for TX
            r = barHeight + (25 * (i / data.length));
            g = 250 * (i / data.length);
            b = 255;
        } else {
            // Orange/Red for RX to distinguish
            r = 255;
            g = 150 * (i / data.length);
            b = 50;
        }

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.shadowBlur = 10;
        ctx.shadowColor = type === "TX" ? "rgba(0, 243, 255, 0.5)" : "rgba(255, 100, 0, 0.5)";

        ctx.fillRect(x, cvs.height - barHeight, barWidth, barHeight);

        x += barWidth + 1;
    }
}


// --- WebRTC Core ---

socket.on('user-connected', (userId) => {
    console.log('User connected:', userId);
    statusText.innerText = "PEER FOUND";
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

        // Mobile fix: ensure audio can play
        remoteAudio.autoplay = true;
        remoteAudio.playsInline = true;
        remoteAudio.muted = false; // Ensure not muted

        // Create Analyser for Remote Stream
        if (audioContext) {
            remoteAnalyser = audioContext.createAnalyser();
            remoteAnalyser.fftSize = 256;
            remoteDataArray = new Uint8Array(remoteAnalyser.frequencyBinCount);

            const remoteSource = audioContext.createMediaStreamSource(event.streams[0]);
            remoteSource.connect(remoteAnalyser);
            // Verify destination - some browsers need it connected to destination to play, 
            // but the Audio element below handles playback. 
            // Connecting to destination here *might* cause double audio if the <audio> element is also playing.
            // Since we have `remoteAudio` (audio element), we DON'T connect `remoteSource` to `audioContext.destination` directly 
            // to avoid echo/feedback issues, unless the audio element method fails.
            // The Visualizer hook is safe.
        }

        // Android/Chrome requires manual play call sometimes
        const playPromise = remoteAudio.play();
        if (playPromise !== undefined) {
            playPromise.catch(error => console.warn("Auto-play prevented:", error));
        }

        // Visual RX feedback
        statusText.innerText = "RECEIVING";
        pttContainer.classList.add('receiving');

        setTimeout(() => {
            pttContainer.classList.remove('receiving');
            if (isPoweredOn && !talkBtn.classList.contains('talking')) {
                statusText.innerText = "CONNECTED";
            }
        }, 1500);
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { candidate: event.candidate, target: targetId });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
    };

    return pc;
}

async function createOffer(targetId) {
    const pc = createPeerConnection(targetId);
    const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false
    });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { offer, target: targetId });
}

socket.on('offer', async (data) => {
    if (!isPoweredOn) return;
    const pc = createPeerConnection(data.caller);
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { answer, target: data.caller });
});

socket.on('answer', async (data) => {
    const pc = peers[data.caller];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
});

socket.on('ice-candidate', async (data) => {
    const pc = peers[data.caller];
    if (pc) try { await pc.addIceCandidate(data.candidate); } catch (e) { }
});

socket.on('user-disconnected', (userId) => {
    if (peers[userId]) {
        peers[userId].close();
        delete peers[userId];
    }
});
