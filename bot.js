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
    process.on('message', async (msg) => {
        if (msg && msg.type === 'CHECK_NUMBER' && msg.target) {
            try {
                // Normalisasi nomor
                const targetJid = msg.target.includes('@s.whatsapp.net') ? msg.target : `${msg.target}@s.whatsapp.net`;
                
                // 1. Cek apakah nomor terdaftar
                const [onWa] = await sock.onWhatsApp(targetJid);
                
                if (!onWa || !onWa.exists) {
                    process.send({
                        type: 'CHECK_RESULT',
                        requestId: msg.requestId,
                        data: null // Mengirim null artinya tidak ditemukan
                    });
                    return;
                }

                // 2. Ambil Foto Profil (PP)
                let ppUrl = 'https://telegra.ph/file/558661849a0d310e5349e.png'; // Default
                try { ppUrl = await sock.profilePictureUrl(targetJid, 'image'); } catch (e) {}

                // 3. Ambil Status / Bio (Text & Tanggal)
                let statusData = { status: 'Tidak ada status / Privasi', setAt: null };
                try { statusData = await sock.fetchStatus(targetJid); } catch (e) {}

                // 4. Cek Business Profile (Alamat, Web, Kategori)
                let businessProfile = null;
                let isBusiness = false;
                try {
                    businessProfile = await sock.getBusinessProfile(targetJid);
                    isBusiness = true; // Jika sukses fetch business profile, berarti WA Business
                } catch (e) {
                    isBusiness = false; // Gagal fetch biasanya karena akun biasa (Personal)
                }

                // 5. Susun Data Hasil
                const result = {
                    number: targetJid.split('@')[0],
                    exists: true,
                    // Tipe Akun
                    type: isBusiness ? 'WhatsApp Business' : 'WhatsApp Personal',
                    // Nama (Prioritas: Bisnis Profile > Notify Name > Unknown)
                    status: statusData.status,
                    name: statusData.setAt ? new Date(statusData.setAt).toLocaleString('id-ID') : 'Tidak Diketahui',
                    statusDate: businessProfile?.description || onWa.name || 'Tidak Diketahui', 
                    ppUrl: ppUrl,
                    // Info Bisnis Lengkap
                    category: businessProfile?.category || 'Privat',
                    address: businessProfile?.address || 'Privat',
                    email: businessProfile?.email || 'Privat',
                    website: businessProfile?.website?.[0] || 'Privat'
                };

                // Kirim balik ke Server
                process.send({
                    type: 'CHECK_RESULT',
                    requestId: msg.requestId,
                    data: result
                });

            } catch (error) {
                console.error('[CHECK ERROR]', error);
                process.send({
                    type: 'CHECK_RESULT',
                    requestId: msg.requestId,
                    data: null
                });
            }
        }
    });

    // --- MESSAGE HANDLER (DIPERBARUI) ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message) return;

            // Dapatkan nomor Bot Sendiri (Untuk dikirim ke chat sendiri)
            const botNumber = sock.user && sock.user.id ? jidNormalizedUser(sock.user.id) : null;

            // --- FITUR 1: ANTI DELETE ---
            // Cek apakah pesan tipe protocol (Revoke/Delete)
            if (m.message.protocolMessage && m.message.protocolMessage.type === 0) {
                const keyToDelete = m.message.protocolMessage.key;
                
                // Cari pesan yang dihapus di store
                if (messageStore.has(keyToDelete.id)) {
                    const msg = messageStore.get(keyToDelete.id);
                    
                    // Jangan respon jika yang hapus adalah bot sendiri
                    if (msg.key.fromMe) return;

                    console.log(`[ANTI-DELETE] Pesan ditarik oleh ${msg.pushName || 'Unknown'}`);
                    
                    // Ambil konten pesan yang dihapus
                    const msgType = getContentType(msg.message);
                    
                    // Forward/Kirim ulang ke Chat Sendiri (Bot)
                    if (botNumber) {
                        let textCaption = `🚨 *PESAN TERDETEKSI* 🚨\n`;
                        textCaption += `👤 *Dari:* @${msg.key.remoteJid.split('@')[0]}\n`;
                      //  textCaption += `🕒 *Waktu:* ${new Date().toLocaleString()}\n`;
                        textCaption += `⚠️ Pesan Dihapus:`;

                        // Jika pesan teks biasa
                        if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
                            const textBody = msg.message.conversation || msg.message.extendedTextMessage.text;
                            await sock.sendMessage(botNumber, { 
                                text: `${textCaption} *${textBody}*`,
                                mentions: [msg.key.remoteJid]
                            });
                        } 
                        // Jika pesan media (Image/Video/Sticker/Voice)
                        else {
                            // Coba download dan kirim ulang media
                            try {
                                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                                await sock.sendMessage(botNumber, { 
                                    [msgType === 'imageMessage' ? 'image' : 
                                     msgType === 'videoMessage' ? 'video' : 
                                     msgType === 'audioMessage' ? 'audio' : 'document']: buffer,
                                    caption: textCaption,
                                    mentions: [msg.key.remoteJid],
                                    // Properti khusus audio
                                    mimetype: msgType === 'audioMessage' ? 'audio/mpeg' : undefined,
                                    ptt: msgType === 'audioMessage' ? true : undefined
                                });
                            } catch (e) {
                                await sock.sendMessage(botNumber, { text: `${textCaption}\n\n(Media gagal diunduh, mungkin sudah kadaluarsa)` });
                            }
                        }
                    }
                }
                return; // Berhenti di sini jika pesan delete
            }

            // SIMPAN PESAN KE STORE (Untuk Anti-Delete)
            // Hanya simpan pesan masuk (bukan status broadcast jika tidak perlu)
            if (m.key.remoteJid !== 'status@broadcast') {
                messageStore.set(m.key.id, m);
                // Batasi memory, hapus pesan lama jika sudah lebih dari 1000
                if (messageStore.size > 1000) {
                    const firstKey = messageStore.keys().next().value;
                    messageStore.delete(firstKey);
                }
            }

            // --- PARSING PESAN ---
            const jid = m.key.remoteJid;
            const type = getContentType(m.message);
            const body = type === 'conversation' ? m.message.conversation : 
                         type === 'extendedTextMessage' ? m.message.extendedTextMessage.text :
                         type === 'imageMessage' ? m.message.imageMessage.caption :
                         type === 'videoMessage' ? m.message.videoMessage.caption : '';
            
            const isCmd = body.startsWith('.');
            const command = isCmd ? body.slice(1).trim().split(' ').shift().toLowerCase() : '';
            
            // Abaikan pesan dari diri sendiri (Kecuali jika mau ngetes command sendiri)
            // if (m.key.fromMe) return; 

            // --- FITUR 2: RVO (READ VIEW ONCE) ---
// Command: .rvo (dengan mereply pesan view once)
if (command === 'rvo') {
    if (!m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
        return sock.sendMessage(jid, { text: 'Reply pesan ViewOnce dengan .rvo' }, { quoted: m });
    }

    const quotedMsg = m.message.extendedTextMessage.contextInfo.quotedMessage;
    const quotedType = getContentType(quotedMsg);

    console.log('[DEBUG RVO] Quoted message type:', quotedType); // DEBUG
    
    // Pengecekan yang lebih komprehensif untuk ViewOnce
    const isViewOnce = (
        quotedType === 'viewOnceMessage' || 
        quotedType === 'viewOnceMessageV2' ||
        quotedType === 'viewOnceMessageV2Extension' ||
        quotedMsg.viewOnceMessage ||
        quotedMsg.viewOnceMessageV2 ||
        quotedMsg.viewOnceMessageV2Extension
    );
    
    console.log('[DEBUG RVO] Is ViewOnce:', isViewOnce); // DEBUG

    // Cek apakah pesan yang direply adalah ViewOnce
    if (isViewOnce) {
        console.log(`[CMD] User merequest RVO`);
        
        // Ambil isi view once - handle berbagai format
        let viewOnceContent = null;
        
        // Format 1: viewOnceMessage
        if (quotedMsg.viewOnceMessage && quotedMsg.viewOnceMessage.message) {
            viewOnceContent = quotedMsg.viewOnceMessage.message;
        }
        // Format 2: viewOnceMessageV2
        else if (quotedMsg.viewOnceMessageV2 && quotedMsg.viewOnceMessageV2.message) {
            viewOnceContent = quotedMsg.viewOnceMessageV2.message;
        }
        // Format 3: viewOnceMessageV2Extension
        else if (quotedMsg.viewOnceMessageV2Extension && quotedMsg.viewOnceMessageV2Extension.message) {
            viewOnceContent = quotedMsg.viewOnceMessageV2Extension.message;
        }
        // Format 4: Langsung sebagai quotedMsg
        else if (quotedType === 'viewOnceMessage' && quotedMsg.message) {
            viewOnceContent = quotedMsg.message;
        }
        
        if (!viewOnceContent) {
            console.log('[DEBUG RVO] Cannot extract viewOnceContent:', quotedMsg);
      //      return sock.sendMessage(jid, { text: 'Gagal mengekstrak konten ViewOnce.' }, { quoted: m });
        }
        
        const mediaType = getContentType(viewOnceContent);
        console.log('[DEBUG RVO] Media type inside:', mediaType); // DEBUG
        
        // Buat fake object agar bisa didownload oleh Baileys
        const fakeM = {
            key: { 
                remoteJid: jid, 
                id: m.message.extendedTextMessage.contextInfo.stanzaId || crypto.randomBytes(16).toString('hex')
            },
            message: viewOnceContent
        };

        try {
            const buffer = await downloadMediaMessage(fakeM, 'buffer', {}, { logger });
            
            // Kirim ke Chat Sendiri (Bot)
            if (botNumber) {
                const mediaTypeKey = mediaType === 'imageMessage' ? 'image' : 
                                   mediaType === 'videoMessage' ? 'video' : 
                                   'document';
                
                const mediaContent = { 
                    [mediaTypeKey]: buffer,
                    caption: `🚨 *PESAN SEKALI LIHAT* 🚨\n👤 Dari: ${m.pushName || 'Unknown'}\n💬 Chat: ${jid}\n📅 Waktu: ${new Date().toLocaleString('id-ID')}`
                };
                
                // Tambahkan properti untuk audio jika perlu
                if (mediaType === 'audioMessage') {
                    mediaContent.mimetype = 'audio/mpeg';
                    mediaContent.ptt = true;
                }
                
                await sock.sendMessage(botNumber, mediaContent);
       //         await sock.sendMessage(jid, { text: '✅ Media ViewOnce berhasil diambil dan dikirim ke Saved Messages!' }, { quoted: m });
            }
        } catch (e) {
            console.error('[RVO ERROR]', e);
            sock.sendMessage(jid, { text: 'Gagal mengambil media RVO. Error: ' + e.message }, { quoted: m });
        }
    } else {
        console.log('[DEBUG RVO] Not a ViewOnce message, structure:', JSON.stringify(quotedMsg, null, 2)); // DEBUG
        sock.sendMessage(jid, { text: 'Pesan yang direply bukan ViewOnce!' }, { quoted: m });
    }
}

            // --- FITUR 3: SAVE STATUS (SW) ---
            // Command: .sw (dengan mereply status orang)
            if (command === '.') {
                if (!m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                    return sock.sendMessage(jid, { text: 'Reply status yang ingin diambil dengan .sw' }, { quoted: m });
                }

                const quotedMsg = m.message.extendedTextMessage.contextInfo.quotedMessage;
                const quotedOwner = m.message.extendedTextMessage.contextInfo.participant; // Pembuat status
                
                // Cek tipe media status (Image/Video)
                if (quotedMsg.imageMessage || quotedMsg.videoMessage) {
                    console.log(`[CMD] User merequest SW`);
                    
                    // Buat fake object untuk download
                    const fakeM = {
                        key: { remoteJid: quotedOwner, id: m.message.extendedTextMessage.contextInfo.stanzaId },
                        message: quotedMsg
                    };

                    try {
                        const buffer = await downloadMediaMessage(fakeM, 'buffer', {}, { logger });
                        const isVideo = !!quotedMsg.videoMessage;

                        // Kirim ke Chat Sendiri (Bot)
                        if (botNumber) {
                            await sock.sendMessage(botNumber, { 
                                [isVideo ? 'video' : 'image']: buffer,
                                caption: `🚨 *STATUS WHATSAPP* 🚨\n👤 Dari: @${quotedOwner.split('@')[0]}\nCaption: ${quotedMsg.imageMessage?.caption || quotedMsg.videoMessage?.caption || 'Tidak ada caption'}`,
                                mentions: [quotedOwner]
                            });
                     //      await sock.sendMessage(jid, { text: '✅ Status berhasil diambil dan dikirim ke Saved Messages!' }, { quoted: m });
                        }
                    } catch (e) {
                        console.error(e);
                  //      sock.sendMessage(jid, { text: 'Gagal mengambil status. Mungkin sudah kadaluarsa.' }, { quoted: m });
                    }
                } else {
            //        sock.sendMessage(jid, { text: 'Status yang direply bukan Gambar atau Video!' }, { quoted: m });
                }
            }


        } catch (e) {
            console.error('[MESSAGE ERROR]', e);
        }
    });
}

// Menangani Error Uncaught agar child process tidak mati total
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

startBot();
