const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

let sock = null;
let isConnected = false;
let phoneNumber = 'Not Connected';
let pairingCode = null;
let isPairing = false;
const AUTH_DIR = path.join(__dirname, 'auth_info');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const silentLogger = pino({ level: 'fatal' });

async function startSock(pairingPhone = null) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['203X Sender', 'Chrome', '1.0.0'],
            logger: silentLogger
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, pairingCode: pc } = update;
            if (pc && !isPairing) {
                isPairing = true;
                pairingCode = pc;
                console.log(`[PAIR] Code: ${pc}`);
            }
            if (connection === 'open') {
                isConnected = true;
                isPairing = false;
                phoneNumber = sock.user?.id?.split(':')[0] || 'Connected';
                console.log(`[WA] Connected: ${phoneNumber}`);
                pairingCode = null;
            }
            if (connection === 'close') {
                isConnected = false;
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log('[WA] Reconnecting...');
                    setTimeout(() => startSock(), 5000);
                } else {
                    console.log('[WA] Logout');
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
                console.log(`[PAIR] Code: ${code}`);
                return code;
            } catch (err) {
                console.log(`[PAIR] Failed: ${err.message}`);
                throw err;
            }
        }
        return sock;
    } catch (err) {
        console.log(`[ERR] startSock: ${err.message}`);
        return null;
    }
}

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
    if (!phone) return res.status(400).json({ success: false, message: 'Nomor HP harus diisi!' });

    let number = phone.replace(/\D/g, '');
    if (!number.startsWith('62')) number = '62' + number;

    try {
        if (sock) { try { sock.ws?.close(); } catch(e) {} sock = null; }
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
            res.json({ success: true, code: pairingCode });
        } else {
            res.json({ success: false, message: 'Gagal mendapatkan kode pairing. Coba lagi.' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/send', async (req, res) => {
    const { target, message, bugType } = req.body;

    if (!sock || !isConnected) {
        return res.status(400).json({ success: false, message: 'WhatsApp belum terhubung!' });
    }
    if (!target || !message) {
        return res.status(400).json({ success: false, message: 'Target dan pesan harus diisi!' });
    }

    try {
        let number = target.replace(/\D/g, '');
        if (!number.startsWith('62')) number = '62' + number;
        const jid = number + '@s.whatsapp.net';

        const fullMessage = `${bugType || '203X BUG'}\n${message}`;
        await sock.sendMessage(jid, { text: fullMessage });
        console.log(`[SEND] ${bugType} -> ${jid}`);
        res.json({ success: true, message: `Pesan terkirim ke ${target}` });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Gagal kirim: ' + err.message });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        if (sock) { try { sock.ws?.close(); } catch(e) {} sock = null; }
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Running on port ${PORT}`);
    startSock();
});
