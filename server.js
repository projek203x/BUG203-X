const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store untuk session
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent' }) });

// State bot
let sock = null;
let isConnected = false;
let phoneNumber = 'Not Connected';
let pairingCode = null;
let isPairing = false;

// File auth
const AUTH_DIR = './auth_info';

// ============================================================
// START WHATSAPP SOCKET WITH PAIRING CODE
// ============================================================
async function startSock(pairingPhone = null) {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['203X Sender', 'Chrome', '1.0.0'],
        logger: pino({ level: 'silent' }),
        getMessage: async (key) => {
            if (store) {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
            }
            return undefined;
        },
        patchMessageBeforeSending: (msg) => {
            const required = ['senderKeyDistributionMessage', 'protocolMessage'];
            const isRequired = required.some(x => msg[x]);
            if (isRequired) {
                msg = {
                    ...msg,
                    ...({
                        senderKeyDistributionMessage: {
                            ...msg.senderKeyDistributionMessage,
                            distributionId: '203x-sender-' + Date.now()
                        }
                    })
                };
            }
            return msg;
        }
    });

    store?.bind(sock.ev);

    // Event: Connection Update
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, pairingCode: pc } = update;

        if (pc && !isPairing) {
            isPairing = true;
            pairingCode = pc;
            console.log(`📱 KODE PAIRING: ${pc}`);
            console.log('➡️ Masukkan kode ini di web');
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
                console.log('❌ Logout, hapus folder auth_info dan restart');
                isPairing = false;
                pairingCode = null;
            }
        }
    });

    // Event: Creds update
    sock.ev.on('creds.update', saveCreds);

    // Kalo ada nomor pairing, langsung pair
    if (pairingPhone) {
        try {
            const code = await sock.requestPairingCode(pairingPhone);
            pairingCode = code;
            isPairing = true;
            console.log(`📱 KODE PAIRING: ${code}`);
            console.log('➡️ Masukkan kode ini di web');
        } catch (err) {
            console.error('❌ Gagal pairing:', err);
        }
    }

    return sock;
}

// ============================================================
// API ROUTES
// ============================================================

// 1. Status koneksi
app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
        phone: phoneNumber,
        pairingCode: pairingCode,
        isPairing: isPairing
    });
});

// 2. Request Pairing Code
app.post('/api/pair', async (req, res) => {
    const { phone } = req.body;
    
    if (!phone) {
        return res.status(400).json({ success: false, message: 'Nomor HP harus diisi!' });
    }

    // Format nomor
    let number = phone.replace(/\D/g, '');
    if (!number.startsWith('62')) {
        number = '62' + number;
    }

    try {
        // Matikan koneksi lama
        if (sock) {
            sock.ws?.close();
            sock = null;
        }

        // Mulai ulang dengan pairing
        isConnected = false;
        isPairing = false;
        pairingCode = null;

        await startSock(number);
        
        // Tunggu sebentar buat dapet kode
        let waitCount = 0;
        while (!pairingCode && waitCount < 30) {
            await new Promise(r => setTimeout(r, 200));
            waitCount++;
        }

        if (pairingCode) {
            res.json({
                success: true,
                code: pairingCode,
                message: `Kode pairing dikirim ke ${number}`
            });
        } else {
            res.json({
                success: false,
                message: 'Gagal mendapatkan kode pairing. Coba lagi.'
            });
        }
    } catch (err) {
        console.error('❌ Error pairing:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. Kirim pesan
app.post('/api/send', async (req, res) => {
    const { target, message, bugType } = req.body;

    if (!sock || !isConnected) {
        return res.status(400).json({ 
            success: false, 
            message: '❌ Bot WhatsApp belum terhubung! Login dulu di menu Sender.' 
        });
    }

    if (!target || !message) {
        return res.status(400).json({ 
            success: false, 
            message: '❌ Target dan pesan harus diisi!' 
        });
    }

    try {
        // Format nomor: 6281234567890@s.whatsapp.net
        let number = target.replace(/\D/g, '');
        if (!number.startsWith('62')) {
            number = '62' + number;
        }
        const jid = number + '@s.whatsapp.net';

        // Pesan dengan info bug
        const fullMessage = bugType 
            ? `🔴 *${bugType}* dikirim dari 203'X System\n\n${message}`
            : message;

        await sock.sendMessage(jid, { text: fullMessage });
        console.log(`✅ Pesan terkirim ke ${jid}: ${fullMessage}`);
        res.json({ 
            success: true, 
            message: `✅ ${bugType || 'Pesan'} terkirim ke ${target}` 
        });
    } catch (err) {
        console.error('❌ Gagal kirim:', err);
        res.status(500).json({ 
            success: false, 
            message: '❌ Gagal kirim: ' + err.message 
        });
    }
});

// 4. Disconnect / Logout
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) {
            sock.ws?.close();
            sock = null;
        }
        isConnected = false;
        phoneNumber = 'Not Connected';
        pairingCode = null;
        isPairing = false;
        
        // Hapus auth
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        
        res.json({ success: true, message: 'Logout berhasil' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 5. Get connected phone
app.get('/api/phone', (req, res) => {
    res.json({
        connected: isConnected,
        phone: phoneNumber
    });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 Server 203X Sender running at http://localhost:${PORT}`);
    console.log('📱 Mode: Pairing Code (tanpa QR)');
    
    // Start socket tanpa pairing dulu
    startSock();
});
