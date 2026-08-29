const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let sock = null;
let isConnected = false;
let phoneNumber = 'Not Connected';
let pairingCode = null;
let isPairing = false;
const AUTH_DIR = path.join(__dirname, 'auth_info');

// Pastikan folder auth ada
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

async function startSock(pairingPhone = null) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['203X Sender', 'Chrome', '1.0.0'],
            logger: pino({ level: 'silent' })
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, pairingCode: pc } = update;

            if (pc && !isPairing) {
                isPairing = true;
                pairingCode = pc;
                console.log(`📱 KODE PAIRING: ${pc}`);
            }

            if (connection === 'open') {
                isConnected = true;
                isPairing = false;
                phoneNumber = sock.user?.id?.split(':')[0] || 'Connected';
                console.log('✅ WhatsApp Terhubung!');
                console.log(`📱 Nomor: ${phoneNumber}`);
                pairingCode = null;
            }

            if (connection === 'close') {
                isConnected = false;
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting...');
                    setTimeout(() => startSock(), 5000);
                } else {
                    console.log('❌ Logout');
                    isPairing = false;
                    pairingCode = null;
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        if (pairingPhone) {
            try {
                const code = await sock.requestPairingCode(pairingPhone);
                pairingCode = code;
                isPairing = true;
                console.log(`📱 KODE PAIRING: ${code}`);
            } catch (err) {
                console.error('❌ Gagal pairing:', err);
            }
        }

        return sock;
    } catch (err) {
        console.error('❌ Error startSock:', err);
        return null;
    }
}

// ===== ROUTES =====
app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
        phone: phoneNumber,
        pairingCode: pairingCode,
        isPairing: isPairing
    });
});

app.post('/api/pair', async (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ success: false, message: 'Nomor HP harus diisi!' });
    }

    let number = phone.replace(/\D/g, '');
    if (!number.startsWith('62')) number = '62' + number;

    try {
        if (sock) { 
            try { sock.ws?.close(); } catch(e) {}
            sock = null; 
        }
        isConnected = false;
        isPairing = false;
        pairingCode = null;

        await startSock(number);
        
        let waitCount = 0;
        while (!pairingCode && waitCount < 30) {
            await new Promise(r => setTimeout(r, 200));
            waitCount++;
        }

        if (pairingCode) {
            res.json({ success: true, code: pairingCode, message: `Kode pairing: ${pairingCode}` });
        } else {
            res.json({ success: false, message: 'Gagal mendapatkan kode pairing. Coba lagi.' });
        }
    } catch (err) {
        console.error('Error pairing:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/send', async (req, res) => {
    const { target, message, bugType, mode } = req.body;

    if (!sock || !isConnected) {
        return res.status(400).json({ 
            success: false, 
            message: '❌ WhatsApp belum terhubung!' 
        });
    }

    if (!target || !message) {
        return res.status(400).json({ success: false, message: '❌ Target dan pesan harus diisi!' });
    }

    try {
        let number = target.replace(/\D/g, '');
        if (!number.startsWith('62')) number = '62' + number;
        const jid = number + '@s.whatsapp.net';

        const modeText = mode === 'private' ? '🔒 PRIBADI' : '🌐 GLOBAL';
        const fullMessage = `[${modeText}] ${bugType || '203\'X BUG'}\n${message}\n\n📱 203'X System`;

        await sock.sendMessage(jid, { text: fullMessage });
        console.log(`✅ [${modeText}] Pesan terkirim ke ${jid}`);
        res.json({ 
            success: true, 
            message: `✅ ${bugType || 'Pesan'} terkirim ke ${target}` 
        });
    } catch (err) {
        console.error('❌ Gagal kirim:', err);
        res.status(500).json({ success: false, message: '❌ Gagal kirim: ' + err.message });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        if (sock) { 
            try { sock.ws?.close(); } catch(e) {}
            sock = null; 
        }
        isConnected = false;
        phoneNumber = 'Not Connected';
        pairingCode = null;
        isPairing = false;
        
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        
        res.json({ success: true, message: 'Logout berhasil' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Root route
app.get('/', (req, res) => {
    res.send('🚀 203X Sender Bot is running!');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server 203X Sender running at http://0.0.0.0:${PORT}`);
    console.log('📱 Mode: Pairing Code');
    startSock();
});
