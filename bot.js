const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadMediaMessage,
    getContentType
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Ambil Nama Sesi (Nomor HP) dari argumen yang dikirim server.js
const sessionName = process.argv[2];

if (!sessionName) {
    console.error('Nama sesi tidak ditemukan!');
    process.exit(1);
}

// Logger agar tidak terlalu berisik di console server
const logger = pino({ level: 'silent' });

// --- STORE SEDERHANA UNTUK ANTI-DELETE ---
// Menyimpan pesan terakhir dalam memory untuk fitur anti-delete
const messageStore = new Map();

async function startBot() {
    console.log(`[INIT] Memulai bot untuk sesi: ${sessionName}`);
    
    const { state, saveCreds } = await useMultiFileAuthState(`./${sessionName}`);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        browser: Browsers.macOS("Chrome"),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        fireInitQueries: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: true,
        markOnlineOnConnect: true,
    });
    
    // --- PAIRING CODE LOGIC ---
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                // Pastikan nomor bersih
                let phoneNumber = sessionName.replace(/[^0-9]/g, '');
                
                // Request Pairing Code
                const code = await sock.requestPairingCode(phoneNumber);
                
                // PENTING: Format string ini dibaca oleh server.js (regex)
                console.log(`KODE PAIRING: ${code?.match(/.{1,4}/g)?.join('-') || code}`);
            } catch (err) {
                console.error('[PAIRING ERROR]', err.message);
            }
        }, 3000);
    }

    // --- CONNECTION UPDATE ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            let reason = lastDisconnect?.error?.output?.statusCode;
            
            if (reason === DisconnectReason.badSession) {
                console.log(`Bad Session File, Please Delete Session and Scan Again`);
                process.exit();
            } else if (reason === DisconnectReason.connectionClosed) {
                console.log("Connection closed, reconnecting....");
                startBot();
            } else if (reason === DisconnectReason.connectionLost) {
                console.log("Connection Lost from Server, reconnecting...");
                startBot();
            } else if (reason === DisconnectReason.connectionReplaced) {
                console.log("Connection Replaced, Another New Session Opened, Please Close Current Session First");
                process.exit();
            } else if (reason === DisconnectReason.loggedOut) {
                console.log(`Device Logged Out, Please Delete Session file ${sessionName} and Scan Again.`);
                // Hapus folder sesi jika logout
                fs.rmSync(`./${sessionName}`, { recursive: true, force: true });
                process.exit();
            } else if (reason === DisconnectReason.restartRequired) {
                console.log("Restart Required, Restarting...");
                startBot();
            } else if (reason === DisconnectReason.timedOut) {
                console.log("Connection TimedOut, Reconnecting...");
                startBot();
            } else {
                console.log(`Unknown DisconnectReason: ${reason}|${connection}`);
                startBot();
            }
        } else if (connection === 'open') {
            // PENTING: Kata "TERHUBUNG" dibaca oleh server.js
            console.log('TERHUBUNG'); 
            console.log(`[BOT] ${sessionName} Siap digunakan.`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // --- IPC LISTENER (DARI SERVER.JS) ---
    // Menerima perintah CHECK_NUMBER untuk fitur cek kuota/nomor
    process.on('message', async (msg) => {
        if (msg && msg.type === 'CHECK_NUMBER' && msg.target) {
            try {
                // Normalisasi nomor
                const targetJid = msg.target.includes('@s.whatsapp.net') ? msg.target : `${msg.target}@s.whatsapp.net`;
                
                // 1. Cek apakah nomor terdaftar
                const [onWa] = await sock.onWhatsApp(targetJid);
                
                if (!onWa || !onWa.exists) {
                    process.send({ type: 'CHECK_RESULT', requestId: msg.requestId, data: null });
                    return;
                }

                // 2. Ambil Foto Profil (PP)
                let ppUrl = 'https://telegra.ph/file/558661849a0d310e5349e.png'; 
                try { ppUrl = await sock.profilePictureUrl(targetJid, 'image'); } catch (e) {}

                // 3. Ambil Status / Bio
                let statusData = { status: 'Tidak ada status / Privasi', setAt: null };
                try { statusData = await sock.fetchStatus(targetJid); } catch (e) {}

                // 4. Cek Business Profile
                let businessProfile = null;
                let isBusiness = false;
                try {
                    businessProfile = await sock.getBusinessProfile(targetJid);
                    isBusiness = true;
                } catch (e) { isBusiness = false; }

                // 5. Susun Data Hasil
                const result = {
                    number: targetJid.split('@')[0],
                    exists: true,
                    type: isBusiness ? 'WhatsApp Business' : 'WhatsApp Personal',
                    status: statusData.status,
                    name: statusData.setAt ? new Date(statusData.setAt).toLocaleString('id-ID') : 'Tidak Diketahui',
                    statusDate: businessProfile?.description || onWa.name || 'User WhatsApp', 
                    ppUrl: ppUrl
                };

                process.send({ type: 'CHECK_RESULT', requestId: msg.requestId, data: result });

            } catch (error) {
                console.error('[CHECK ERROR]', error);
                process.send({ type: 'CHECK_RESULT', requestId: msg.requestId, data: null });
            }
        }
    });

    // --- MESSAGE HANDLER ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message) return;

            // Dapatkan nomor Bot Sendiri
            const botNumber = sock.user && sock.user.id ? jidNormalizedUser(sock.user.id) : null;

            // --- FITUR 1: ANTI DELETE ---
            if (m.message.protocolMessage && m.message.protocolMessage.type === 0) {
                const keyToDelete = m.message.protocolMessage.key;
                if (messageStore.has(keyToDelete.id)) {
                    const msg = messageStore.get(keyToDelete.id);
                    if (msg.key.fromMe) return; // Ignore self delete

                    console.log(`[ANTI-DELETE] Pesan ditarik oleh ${msg.pushName || 'Unknown'}`);
                    const msgType = getContentType(msg.message);
                    
                    if (botNumber) {
                        let textCaption = `🚨 *PESAN TERDETEKSI* 🚨\n`;
                        textCaption += `👤 *Dari:* @${msg.key.remoteJid.split('@')[0]}\n`;
                        textCaption += `⚠️ Pesan Dihapus:`;

                        if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
                            const textBody = msg.message.conversation || msg.message.extendedTextMessage.text;
                            await sock.sendMessage(botNumber, { text: `${textCaption} *${textBody}*`, mentions: [msg.key.remoteJid] });
                        } else {
                            try {
                                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                                await sock.sendMessage(botNumber, { 
                                    [msgType === 'imageMessage' ? 'image' : msgType === 'videoMessage' ? 'video' : 'document']: buffer,
                                    caption: textCaption,
                                    mentions: [msg.key.remoteJid]
                                });
                            } catch (e) { await sock.sendMessage(botNumber, { text: `${textCaption}\n\n(Media gagal diunduh)` }); }
                        }
                    }
                }
                return;
            }

            // SIMPAN PESAN (Anti-Delete)
            if (m.key.remoteJid !== 'status@broadcast') {
                messageStore.set(m.key.id, m);
                if (messageStore.size > 1000) { messageStore.delete(messageStore.keys().next().value); }
            }

            // PARSING
            const jid = m.key.remoteJid;
            const type = getContentType(m.message);
            const body = type === 'conversation' ? m.message.conversation : 
                         type === 'extendedTextMessage' ? m.message.extendedTextMessage.text :
                         type === 'imageMessage' ? m.message.imageMessage.caption :
                         type === 'videoMessage' ? m.message.videoMessage.caption : '';
            
            const isCmd = body.startsWith('.');
            const command = isCmd ? body.slice(1).trim().split(' ').shift().toLowerCase() : '';

            // --- FITUR 2: RVO (READ VIEW ONCE) ---
            if (command === 'rvo') {
                if (!m.message.extendedTextMessage?.contextInfo?.quotedMessage) return sock.sendMessage(jid, { text: 'Reply pesan ViewOnce dengan .rvo' }, { quoted: m });

                const quotedMsg = m.message.extendedTextMessage.contextInfo.quotedMessage;
                // Cek ViewOnce
                let viewOnceContent = quotedMsg.viewOnceMessage?.message || quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessageV2Extension?.message;
                
                if (viewOnceContent) {
                    console.log(`[CMD] RVO Requested`);
                    const mediaType = getContentType(viewOnceContent);
                    
                    const fakeM = {
                        key: { remoteJid: jid, id: crypto.randomBytes(16).toString('hex') },
                        message: viewOnceContent
                    };

                    try {
                        const buffer = await downloadMediaMessage(fakeM, 'buffer', {}, { logger });
                        if (botNumber) {
                            const mediaTypeKey = mediaType === 'imageMessage' ? 'image' : mediaType === 'videoMessage' ? 'video' : 'document';
                            await sock.sendMessage(botNumber, { 
                                [mediaTypeKey]: buffer,
                                caption: `🚨 *PESAN SEKALI LIHAT* 🚨\n👤 Dari: ${m.pushName || 'Unknown'}`
                            });
                        }
                    } catch (e) { sock.sendMessage(jid, { text: 'Gagal mengambil RVO.' }, { quoted: m }); }
                } else {
                    sock.sendMessage(jid, { text: 'Bukan pesan ViewOnce!' }, { quoted: m });
                }
            }

            // --- FITUR 3: SAVE STATUS (SW) ---
            if (command === '.') {
                if (!m.message.extendedTextMessage?.contextInfo?.quotedMessage) return;

                const quotedMsg = m.message.extendedTextMessage.contextInfo.quotedMessage;
                const quotedOwner = m.message.extendedTextMessage.contextInfo.participant;
                
                if (quotedMsg.imageMessage || quotedMsg.videoMessage) {
                    const fakeM = { key: { remoteJid: quotedOwner, id: m.message.extendedTextMessage.contextInfo.stanzaId }, message: quotedMsg };
                    try {
                        const buffer = await downloadMediaMessage(fakeM, 'buffer', {}, { logger });
                        const isVideo = !!quotedMsg.videoMessage;
                        if (botNumber) {
                            await sock.sendMessage(botNumber, { 
                                [isVideo ? 'video' : 'image']: buffer,
                                caption: `🚨 *STATUS WHATSAPP* 🚨\n👤 Dari: @${quotedOwner.split('@')[0]}\nCaption: ${quotedMsg.imageMessage?.caption || quotedMsg.videoMessage?.caption || '-'}`
                            });
                        }
                    } catch (e) {}
                }
            }

        } catch (e) { console.error('[MSG ERROR]', e); }
    });
}

// Handle Errors
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

startBot();
