const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const btch = require('btch-downloader');

// ====================================================
// ⚙️ KONFIGURASI SERVER
// ====================================================
const BIN_ID = '693151eed0ea881f40121ca6'; 
const API_KEY = '$2a$10$u00Qvq6xrri32tc7bEYVhuQv94XS.ygeVCr70UDbzoOVlR8yLuUq.'; 
let PORT = 0; // Akan diisi otomatis
// ====================================================

const USERS_FILE = path.join(__dirname, 'users.json');
const BOTS_META_FILE = path.join(__dirname, 'bots.json');
const USER_PROFILES_FILE = path.join(__dirname, 'profiles.json');

// --- DATABASE MANAGERS ---
let usersDB = [];
if (fs.existsSync(USERS_FILE)) { try { usersDB = JSON.parse(fs.readFileSync(USERS_FILE)); } catch { usersDB = []; } } else { fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2)); }
const saveUsers = () => fs.writeFileSync(USERS_FILE, JSON.stringify(usersDB, null, 2));

let botsMeta = {};
if (fs.existsSync(BOTS_META_FILE)) { try { botsMeta = JSON.parse(fs.readFileSync(BOTS_META_FILE)); } catch { botsMeta = {}; } }
const saveBotMeta = () => fs.writeFileSync(BOTS_META_FILE, JSON.stringify(botsMeta, null, 2));

let userProfiles = {};
if (fs.existsSync(USER_PROFILES_FILE)) { try { userProfiles = JSON.parse(fs.readFileSync(USER_PROFILES_FILE)); } catch { userProfiles = {}; } }
const saveUserProfiles = () => fs.writeFileSync(USER_PROFILES_FILE, JSON.stringify(userProfiles, null, 2));

const activeBots = new Map();
const pairingCodes = new Map();
const activeSessions = new Map();
const checkRequests = new Map(); // Map untuk menyimpan request Cek Nomor yang pending

// --- CLOUD UPDATE (JSONBIN) ---
async function updateCloudUrl(url) {
    if(BIN_ID.includes('MASUKKAN')) return;
    try { 
        const cleanUrl = url.trim();
        console.log(`[CLOUD] 🟢 Updating JSONBin: ${cleanUrl}`);
        await axios.put(`https://api.jsonbin.io/v3/b/${BIN_ID}`, { url: cleanUrl }, { headers: { 'X-Master-Key': API_KEY, 'Content-Type': 'application/json' } }); 
    } catch (e) { console.error('[CLOUD ERROR]', e.message); }
}

// --- HELPER FUNCTIONS ---
const generateToken = () => crypto.randomBytes(16).toString('hex');
const getSessionInfo = (req) => {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.split(' ')[1];
    else if (req.headers.cookie) {
        const c = req.headers.cookie.split(';').reduce((a, b) => { const [n, v] = b.trim().split('='); a[n] = v; return a; }, {});
        token = c.auth_token;
    }
    return token ? activeSessions.get(token) : null;
};
const isAuthenticated = (req) => !!getSessionInfo(req);
const normalizePhone = (ph) => {
    let p = ph.replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.substring(1);
    else if (p.startsWith('8')) p = '62' + p;
    return p;
};
const formatDate = (date) => {
    const d = new Date(date);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// --- BOT PROCESS MANAGEMENT ---
const getSessions = () => fs.readdirSync('./').filter(file => fs.statSync(file).isDirectory() && /^\d+$/.test(file));

const startBotProcess = (sessionName) => {
    const meta = botsMeta[sessionName];
    if (!meta) return { success: false, message: 'Sesi tidak ditemukan' };
    if (activeBots.has(sessionName)) return { success: false, message: 'Sudah Jalan' };
    
    pairingCodes.delete(sessionName);
    
    // Spawn Child Process
    const child = spawn('node', ['bot.js', sessionName], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'], // Enable IPC channel
        shell: true,
        env: { ...process.env, RVO_MODE: 'true' }
    });

    activeBots.set(sessionName, child);

    // Baca Output Console dari Child
    child.stdout.on('data', (d) => {
        const lines = d.toString().trim().split('\n');
        lines.forEach(l => {
            const clean = l.trim();
            if (clean) {
                if (clean.includes('KODE PAIRING')) {
                    const code = clean.split(':').pop().trim();
                    pairingCodes.set(sessionName, code);
                    console.log(`\x1b[32m[PAIRING CODE] ${sessionName} : ${code}\x1b[0m`);
                }
                if (clean.includes('TERHUBUNG')) pairingCodes.set(sessionName, 'CONNECTED');
            }
        });
    });
    
    // Handle Pesan IPC dari Child (Hasil Cek Nomor)
    child.on('message', (msg) => {
        if (msg && msg.type === 'CHECK_RESULT' && msg.requestId) {
            const resolver = checkRequests.get(msg.requestId);
            if (resolver) { 
                resolver(msg.data); 
                checkRequests.delete(msg.requestId); 
            }
        }
    });

    child.on('close', () => activeBots.delete(sessionName));
    return { success: true };
};

const stopBotProcess = (sessionName) => { 
    if(activeBots.has(sessionName)) { 
        activeBots.get(sessionName).kill(); 
        activeBots.delete(sessionName); 
        return { success: true }; 
    } 
    return { success: false }; 
};

const deleteSession = (sessionName) => { 
    if(activeBots.has(sessionName)) activeBots.get(sessionName).kill(); 
    try { 
        fs.rmSync(`./${sessionName}`, {recursive:true, force:true}); 
        delete botsMeta[sessionName]; 
        saveBotMeta(); 
        return {success:true}; 
    } catch(e) { return {success:false}; } 
};

const addSession = (ph, owner) => {
    let p = normalizePhone(ph);
    if (getSessions().includes(p)) return { success: false, message: 'Nomor ada' };
    
    botsMeta[p] = { owner: owner, active: true, created: Date.now() };
    saveBotMeta();
    pairingCodes.set(p, 'WAITING');
    
    const child = spawn('node', ['bot.js', p], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], shell: true });
    activeBots.set(p, child);
    
    child.stdout.on('data', (d) => {
        const l = d.toString();
        if(l.includes('KODE PAIRING')) { 
            const code = l.split(':').pop().trim(); 
            pairingCodes.set(p, code); 
            console.log(`\x1b[32m[PAIRING CODE] ${p} : ${code}\x1b[0m`); 
        }
        if(l.includes('TERHUBUNG')) pairingCodes.set(p, 'CONNECTED');
    });
    
    setTimeout(() => { 
        if(activeBots.has(p) && pairingCodes.get(p) !== 'CONNECTED') { 
            activeBots.get(p).kill(); 
            activeBots.delete(p); 
        } 
    }, 120000); // 2 menit timeout pairing
    
    return {success:true, phone:p};
};

// --- DOWNLOADER SCRAPER ---
async function fetchMediaData(url) {
    console.log(`[DOWNLOAD] Memproses: ${url}`);
    const formatResult = (title, thumb, url, type = 'mp4') => ({ title: title || 'Media Result', thumbnail: thumb || 'https://telegra.ph/file/558661849a0d310e5349e.png', url: url, type: type });
    try {
        let res = null;
        // Facebook / IG via External API
        if (url.match(/(facebook|fb\.|instagram)/i)) {
            try { const { data } = await axios.get(`https://api.ryzendesu.vip/api/downloader/fbdl?url=${url}`); if(data?.data?.[0]?.url) return formatResult('Facebook/IG DL', data.data[0].thumbnail, data.data[0].url); } catch {}
            try { const { data } = await axios.get(`https://api.agatz.xyz/api/instagram?url=${url}`); if(data?.data?.[0]?.url) return formatResult('Instagram DL', data.data[0].thumbnail, data.data[0].url); } catch {}
        }
        // TikTok / Youtube via btch-downloader
        if (url.includes('tiktok')) { if(btch.tiktok) res = await btch.tiktok(url); else if(btch.ttdl) res = await btch.ttdl(url); }
        else if (url.includes('youtu')) { if(btch.youtube) res = await btch.youtube(url); else if(btch.ytdl) res = await btch.ytdl(url); }
        
        if (!res) return null;
        
        let finalUrl = '', finalThumb = '', finalTitle = 'Downloaded Media';
        if (typeof res === 'string') finalUrl = res;
        else if (Array.isArray(res)) finalUrl = res[0]?.url || res[0];
        else if (typeof res === 'object') { finalUrl = res.url || res.video || res.link || res.nowm; finalThumb = res.thumbnail || res.cover; finalTitle = res.title || res.caption || 'Media'; }
        
        if (!finalUrl) return null;
        return formatResult(finalTitle, finalThumb, finalUrl);
    } catch (e) { return null; }
}

// ====================================================
// 🚀 HTTP SERVER HANDLER
// ====================================================
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    // --- CORS HEADER ---
    const origin = req.headers.origin;
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    else res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    
    const send = (d, s=200) => { res.writeHead(s, {'Content-Type':'application/json'}); res.end(JSON.stringify(d)); };

    // --- ROUTES ---
    if (url.pathname === '/') { send({ status: 'Online', message: 'Bot Manager Server Running' }); }
    
    // LOGIN
    else if (url.pathname === '/api/login' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            const {user, pass} = JSON.parse(body);
            let role = (user === 'admin' && pass === '1510') ? 'admin' : (usersDB.find(u => u.user === user && u.pass === pass) ? 'user' : null);
            if (role) {
                const token = generateToken();
                activeSessions.set(token, {role, user});
                if (!userProfiles[user]) { userProfiles[user] = { userId: crypto.randomBytes(8).toString('hex'), joinDate: Date.now(), photoUrl: null }; saveUserProfiles(); }
                send({success: true, token: token}); 
            } else { send({success: false, message: 'Username atau password salah'}, 401); }
        });
    }
    
    // REGISTER
    else if (url.pathname === '/api/register' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            const {user, pass} = JSON.parse(body);
            if (!user || !pass) return send({success: false, message: 'Isi lengkap'});
            if (usersDB.find(u => u.user === user) || user === 'admin') return send({success: false, message: 'Username sudah ada'});
            usersDB.push({user, pass, joinDate: Date.now()}); saveUsers();
            userProfiles[user] = { userId: crypto.randomBytes(8).toString('hex'), joinDate: Date.now(), photoUrl: null }; saveUserProfiles();
            send({success: true});
        });
    }
    
    // RESET PASS
    else if (url.pathname === '/api/reset-password' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            const {user, phone, newPass} = JSON.parse(body);
            const userIndex = usersDB.findIndex(u => u.user === user);
            if (userIndex === -1) return send({success: false, message: 'User 404'});
            const bot = botsMeta[normalizePhone(phone)];
            if (bot && bot.owner === user) { usersDB[userIndex].pass = newPass; saveUsers(); send({success: true}); } 
            else { send({success: false, message: 'Verifikasi Gagal'}); }
        });
    }
    
    // LOGOUT
    else if (url.pathname === '/api/logout' && req.method === 'POST') { send({success: true}); }
    
    // PROFILE
    else if (url.pathname === '/api/profile') {
        const session = getSessionInfo(req); if (!session) return send({}, 401);
        const profile = userProfiles[session.user] || {};
        const userBots = Object.keys(botsMeta).filter(bot => botsMeta[bot]?.owner === session.user);
        send({
            name: session.user, userId: profile.userId || 'N/A',
            joinDate: profile.joinDate ? formatDate(profile.joinDate) : 'N/A',
            photoUrl: profile.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(session.user)}&background=4e54c8&color=fff`,
            role: session.role, totalBots: userBots.length, activeBots: userBots.filter(b => activeBots.has(b)).length
        });
    }
    
    // DASHBOARD DATA
    else if (url.pathname === '/api/data') {
        const session = getSessionInfo(req); if (!session) return send({}, 401);
        send({ user: session.user, role: session.role, sessions: getSessions(), meta: botsMeta, activeBots: Array.from(activeBots.keys()) });
    }

    // === FITUR CEK NOMOR / KUOTA REAL (IPC) ===
    else if (url.pathname === '/api/feature/quota' && req.method === 'POST') {
        const s = getSessionInfo(req); if(!s) return send({}, 401);
        let b=''; req.on('data', c=>b+=c); req.on('end', async ()=>{
            try {
                const { number, provider } = JSON.parse(b); // provider (xl/axis) bisa dipake untuk logika tambahan kalau mau
                
                // Cari bot aktif milik user
                let botSession = Array.from(activeBots.keys()).find(b => botsMeta[b]?.owner === s.user);
                // Fallback: Jika user tidak punya bot, pinjam bot admin/pertama yg aktif
                if(!botSession && activeBots.size > 0) botSession = Array.from(activeBots.keys())[0];
                
                if(!botSession) return send({success:false, message: 'Tidak ada bot aktif untuk melakukan pengecekan.'});
                
                const child = activeBots.get(botSession);
                const requestId = crypto.randomBytes(8).toString('hex');
                
                // Buat Promise yang menunggu balasan dari Child Process
                const checkPromise = new Promise((resolve) => {
                    checkRequests.set(requestId, resolve);
                    // Timeout 15 detik
                    setTimeout(() => { if(checkRequests.has(requestId)) { checkRequests.delete(requestId); resolve(null); } }, 15000);
                });
                
                if (child.send) {
                    // Kirim perintah ke bot.js
                    child.send({ type: 'CHECK_NUMBER', target: normalizePhone(number), requestId: requestId });
                    
                    // Tunggu hasil
                    const result = await checkPromise;
                    
                    if(result) {
                        // Format data agar sesuai tampilan Sidompul di Front-end
                        // Karena bot WA tidak bisa cek pulsa asli operator, kita kirim data profil WA
                        // Tapi front-end akan merendernya seolah-olah data provider
                        send({
                            success:true, 
                            data: {
                                nomor: result.number,
                                pulsa: "Cek Aplikasi Operator", // WA tidak bisa cek pulsa
                                masaAktif: result.statusDate || "Aktif",
                                packages: [
                                    { name: "Status WA", total: "Info", remaining: result.status || "-", percent: 100 },
                                    { name: "Tipe Akun", total: "Info", remaining: result.type, percent: 100 }
                                ]
                            }
                        }); 
                    } else { 
                        send({success:false, message: 'Nomor tidak terdaftar di WhatsApp atau Timeout'}); 
                    }
                } else { send({success:false, message: 'IPC Error'}); }
            } catch (e) { send({success:false, message: 'Internal Server Error'}); }
        });
    }
    
    // CEK NOMOR BIASA
    else if (url.pathname === '/api/check-number' && req.method === 'POST') {
        const s = getSessionInfo(req); if(!s) return send({}, 401);
        let b=''; req.on('data', c=>b+=c); req.on('end', async ()=>{
            try {
                const { target } = JSON.parse(b);
                let botSession = Array.from(activeBots.keys()).find(b => botsMeta[b]?.owner === s.user);
                if(!botSession && activeBots.size > 0) botSession = Array.from(activeBots.keys())[0];
                if(!botSession) return send({success:false, message: 'Tidak ada bot aktif'});
                const child = activeBots.get(botSession);
                const requestId = crypto.randomBytes(8).toString('hex');
                const checkPromise = new Promise((resolve) => {
                    checkRequests.set(requestId, resolve);
                    setTimeout(() => { if(checkRequests.has(requestId)) { checkRequests.delete(requestId); resolve(null); } }, 15000);
                });
                if (child.send) {
                    child.send({ type: 'CHECK_NUMBER', target: normalizePhone(target), requestId: requestId });
                    const result = await checkPromise;
                    if(result) send({success:true, data: result}); else send({success:false, message: 'Timeout/Invalid'});
                } else { send({success:false, message: 'IPC Error'}); }
            } catch (e) { send({success:false, message: 'Error'}); }
        });
    }
    
    // DOWNLOADER
    else if (url.pathname === '/api/download' && req.method === 'POST') {
        const session = getSessionInfo(req); if (!session) return send({}, 401);
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', async () => {
            const { url, type } = JSON.parse(body);
            const data = await fetchMediaData(url, type);
            send(data ? {success:true, data} : {success:false, message: 'Gagal'});
        });
    }
    
    // ADD BOT
    else if (url.pathname === '/api/add' && req.method === 'POST') {
        const session = getSessionInfo(req); if (!session) return send({}, 401);
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            const {phone} = JSON.parse(body);
            send(addSession(phone, session.user));
        });
    }
    
    // GET CODE
    else if (url.pathname.startsWith('/api/code/')) {
        if (!isAuthenticated(req)) return send({}, 401);
        send({code: pairingCodes.get(url.pathname.split('/').pop()) || 'WAITING'});
    }
    
    // START/STOP/DELETE
    else if (url.pathname.startsWith('/api/start/')) {
        const session = getSessionInfo(req); if (!session) return send({}, 401);
        const p = url.pathname.split('/').pop();
        if (session.role === 'admin' || botsMeta[p]?.owner === session.user) send(startBotProcess(p)); else send({}, 403);
    }
    else if (url.pathname.startsWith('/api/restart/')) {
        const s = getSessionInfo(req); if(!s) return send({}, 401);
        const p = url.pathname.split('/').pop();
        if(s.role==='admin' || botsMeta[p]?.owner===s.user) {
            stopBotProcess(p); 
            setTimeout(()=>send(startBotProcess(p)), 2000); 
        } else send({}, 403);
    }
    else if (url.pathname.startsWith('/api/stop/')) {
        const session = getSessionInfo(req); if (!session) return send({}, 401);
        const p = url.pathname.split('/').pop();
        if (session.role === 'admin' || botsMeta[p]?.owner === session.user) send(stopBotProcess(p)); else send({}, 403);
    }
    else if (url.pathname.startsWith('/api/delete/')) {
        const session = getSessionInfo(req); if (!session) return send({}, 401);
        if (session.role === 'admin') send(deleteSession(url.pathname.split('/').pop())); else send({success:false}, 403);
    }
    else { res.writeHead(404); res.end('404'); }
});

// --- CLOUDFLARE TUNNEL ---
let tunnelProcess = null;
function startTunnel() {
    try { require('child_process').execSync('pkill cloudflared'); } catch {}

    console.log(`\x1b[36m[TUNNEL]\x1b[0m Starting Cloudflare Tunnel → http://localhost:${PORT}`);

    tunnelProcess = spawn(
        'cloudflared',
        ['tunnel', '--url', `http://localhost:${PORT}`],
        { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    tunnelProcess.stderr.on('data', (data) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match) {
            const publicUrl = match[0];
            console.log(`\x1b[32m[TUNNEL]\x1b[0m PUBLIC URL: ${publicUrl}`);
            updateCloudUrl(publicUrl);
        }
    });

    tunnelProcess.on('close', (code) => {
        console.log(`\x1b[31m[TUNNEL]\x1b[0m Closed (${code}), restart in 5s`);
        setTimeout(startTunnel, 5000);
    });
}

// START
const DEFAULT_PORT = process.env.PORT ? Number(process.env.PORT) : 0;
server.listen(DEFAULT_PORT, () => {
    PORT = server.address().port;
    console.log('\x1b[32m%s\x1b[0m', '====================================');
    console.log(`\x1b[33m[SERVER]\x1b[0m Running on port ${PORT}`);
    console.log(`\x1b[36m[ENV]\x1b[0m Codespaces: ${!!process.env.CODESPACES}`);
    console.log('\x1b[32m%s\x1b[0m', '====================================');
    startTunnel();
});
