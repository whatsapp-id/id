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
let PORT = 0;
// ====================================================

const USERS_FILE = path.join(__dirname, 'users.json');
const BOTS_META_FILE = path.join(__dirname, 'bots.json');
const USER_PROFILES_FILE = path.join(__dirname, 'profiles.json');
const LOTTERY_FILE = path.join(__dirname, 'lottery.json');
const TOPUPS_FILE = path.join(__dirname, 'topups.json');

// --- DATABASE MANAGERS ---
const loadJSON = (file, defaultVal) => {
    if (fs.existsSync(file)) {
        try { return JSON.parse(fs.readFileSync(file)); } catch { return defaultVal; }
    } else {
        fs.writeFileSync(file, JSON.stringify(defaultVal, null, 2));
        return defaultVal;
    }
};

let usersDB = loadJSON(USERS_FILE, []);
let botsMeta = loadJSON(BOTS_META_FILE, {});
let userProfiles = loadJSON(USER_PROFILES_FILE, {});
let lotteryDB = loadJSON(LOTTERY_FILE, []);
let topupsDB = loadJSON(TOPUPS_FILE, []);

const saveUsers = () => fs.writeFileSync(USERS_FILE, JSON.stringify(usersDB, null, 2));
const saveBotMeta = () => fs.writeFileSync(BOTS_META_FILE, JSON.stringify(botsMeta, null, 2));
const saveUserProfiles = () => fs.writeFileSync(USER_PROFILES_FILE, JSON.stringify(userProfiles, null, 2));
const saveLottery = () => fs.writeFileSync(LOTTERY_FILE, JSON.stringify(lotteryDB, null, 2));
const saveTopups = () => fs.writeFileSync(TOPUPS_FILE, JSON.stringify(topupsDB, null, 2));

const activeBots = new Map();
const pairingCodes = new Map();
const activeSessions = new Map();
const checkRequests = new Map();

async function updateCloudUrl(url) {
    if(BIN_ID.includes('MASUKKAN')) return;
    try { 
        const cleanUrl = url.trim();
        console.log(`[CLOUD] 🟢 Updating JSONBin: ${cleanUrl}`);
        await axios.put(`https://api.jsonbin.io/v3/b/${BIN_ID}`, { url: cleanUrl }, { headers: { 'X-Master-Key': API_KEY, 'Content-Type': 'application/json' } }); 
    } catch (e) { console.error('[CLOUD ERROR]', e.message); }
}

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

// --- BOT PROCESS ---
const getSessions = () => fs.readdirSync('./').filter(file => fs.statSync(file).isDirectory() && /^\d+$/.test(file));

const startBotProcess = (sessionName) => {
    const meta = botsMeta[sessionName];
    if (!meta) return { success: false, message: 'Sesi tidak ditemukan' };
    if (activeBots.has(sessionName)) return { success: false, message: 'Sudah Jalan' };
    
    pairingCodes.delete(sessionName);
    const child = spawn('node', ['bot.js', sessionName], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        shell: true,
        env: { ...process.env, RVO_MODE: 'true', SWSAVE_MODE: 'true', ANTIBAN_MODE: 'true' }
    });

    activeBots.set(sessionName, child);
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
    
    child.on('message', (msg) => {
        if (msg && msg.type === 'CHECK_RESULT' && msg.requestId) {
            const resolver = checkRequests.get(msg.requestId);
            if (resolver) { resolver(msg.data); checkRequests.delete(msg.requestId); }
        }
    });
    child.on('close', () => activeBots.delete(sessionName));
    return { success: true };
};

const stopBotProcess = (sessionName) => { if(activeBots.has(sessionName)) { activeBots.get(sessionName).kill(); activeBots.delete(sessionName); return { success: true }; } return { success: false }; };
const deleteSession = (sessionName) => { if(activeBots.has(sessionName)) activeBots.get(sessionName).kill(); try { fs.rmSync(`./${sessionName}`, {recursive:true, force:true}); delete botsMeta[sessionName]; saveBotMeta(); return {success:true}; } catch(e) { return {success:false}; } };
const addSession = (ph, owner) => {
    let p = normalizePhone(ph);
    if (getSessions().includes(p)) return { success: false, message: 'Nomor ada' };
    botsMeta[p] = { owner: owner, active: true, isTrial: false, trialEnd: null, created: Date.now() };
    saveBotMeta();
    pairingCodes.set(p, 'WAITING');
    const child = spawn('node', ['bot.js', p], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], shell: true });
    activeBots.set(p, child);
    child.stdout.on('data', (d) => {
        const l = d.toString();
        if(l.includes('KODE PAIRING')) { const code = l.split(':').pop().trim(); pairingCodes.set(p, code); console.log(`\x1b[32m[PAIRING CODE] ${p} : ${code}\x1b[0m`); }
        if(l.includes('TERHUBUNG')) pairingCodes.set(p, 'CONNECTED');
    });
    setTimeout(() => { if(activeBots.has(p) && pairingCodes.get(p) !== 'CONNECTED') { activeBots.get(p).kill(); activeBots.delete(p); } }, 120000);
    return {success:true, phone:p};
};

async function fetchMediaData(url) {
    const formatResult = (title, thumb, url, type = 'mp4') => ({ title: title || 'Media Result', thumbnail: thumb || 'https://telegra.ph/file/558661849a0d310e5349e.png', url: url, type: type });
    try {
        let res = null;
        if (url.match(/(facebook|fb\.|instagram)/i)) {
            try { const { data } = await axios.get(`https://api.ryzendesu.vip/api/downloader/fbdl?url=${url}`); if(data?.data?.[0]?.url) return formatResult('Facebook/IG DL', data.data[0].thumbnail, data.data[0].url); } catch {}
            try { const { data } = await axios.get(`https://api.agatz.xyz/api/instagram?url=${url}`); if(data?.data?.[0]?.url) return formatResult('Instagram DL', data.data[0].thumbnail, data.data[0].url); } catch {}
        }
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

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    // --- FIX CORS ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    
    const send = (d, s=200) => { res.writeHead(s, {'Content-Type':'application/json'}); res.end(JSON.stringify(d)); };

    if (url.pathname === '/') { send({ status: 'Online', message: 'Bot Manager Server Running' }); }
    
    // --- AUTH ---
    else if (url.pathname === '/api/login' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            const {user, pass} = JSON.parse(body);
            let role = (user === 'admin' && pass === '1510') ? 'admin' : (usersDB.find(u => u.user === user && u.pass === pass) ? 'user' : null);
            if (role) {
                const token = generateToken();
                activeSessions.set(token, {role, user});
                // Initialize profile with balance if not exists
                if (!userProfiles[user]) { 
                    userProfiles[user] = { userId: crypto.randomBytes(8).toString('hex'), joinDate: Date.now(), photoUrl: null, phone: null, balance: 0 }; 
                    saveUserProfiles(); 
                } else if (typeof userProfiles[user].balance === 'undefined') {
                    userProfiles[user].balance = 0;
                    saveUserProfiles();
                }
                send({success: true, token: token}); 
            } else { send({success: false, message: 'Username atau password salah'}, 401); }
        });
    }
    else if (url.pathname === '/api/register' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            const {user, pass} = JSON.parse(body);
            if (!user || !pass) return send({success: false, message: 'Isi lengkap'});
            if (usersDB.find(u => u.user === user) || user === 'admin') return send({success: false, message: 'Username sudah ada'});
            usersDB.push({user, pass, joinDate: Date.now()}); saveUsers();
            userProfiles[user] = { userId: crypto.randomBytes(8).toString('hex'), joinDate: Date.now(), photoUrl: null, phone: null, balance: 0 }; saveUserProfiles();
            send({success: true});
        });
    }
    
    // --- DATA & PROFILE ---
    else if (url.pathname === '/api/profile') {
        const session = getSessionInfo(req); if (!session) return send({}, 401);
        const profile = userProfiles[session.user] || { balance: 0 };
        const userBots = Object.keys(botsMeta).filter(bot => botsMeta[bot]?.owner === session.user);
        send({
            name: session.user, userId: profile.userId || 'N/A',
            joinDate: profile.joinDate ? formatDate(profile.joinDate) : 'N/A',
            photoUrl: profile.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(session.user)}&background=128C7E&color=fff`,
            role: session.role, totalBots: userBots.length, activeBots: userBots.filter(b => activeBots.has(b)).length,
            balance: profile.balance || 0
        });
    }

    // --- TOP UP SYSTEM ---
    else if (url.pathname === '/api/topup/request' && req.method === 'POST') {
        const s = getSessionInfo(req); if (!s) return send({success:false}, 401);
        let b=''; req.on('data', c=>b+=c); req.on('end', () => {
            const { amount, bank, sender } = JSON.parse(b);
            const nominal = parseInt(amount);
            if(nominal < 1000) return send({success:false, message: 'Minimal topup 1000'});
            
            topupsDB.push({
                id: crypto.randomBytes(6).toString('hex'),
                user: s.user,
                amount: nominal,
                bank: bank,
                senderName: sender,
                status: 'pending',
                date: Date.now()
            });
            saveTopups();
            send({success:true, message: 'Permintaan Top Up dikirim. Tunggu konfirmasi admin.'});
        });
    }
    else if (url.pathname === '/api/topup/list' && req.method === 'GET') {
        const s = getSessionInfo(req); if (!s || s.role !== 'admin') return send({success:false}, 403);
        send({success:true, data: topupsDB});
    }
    else if (url.pathname === '/api/topup/action' && req.method === 'POST') {
        const s = getSessionInfo(req); if (!s || s.role !== 'admin') return send({success:false}, 403);
        let b=''; req.on('data', c=>b+=c); req.on('end', () => {
            const { id, action } = JSON.parse(b);
            const tx = topupsDB.find(t => t.id === id);
            if(!tx) return send({success:false, message: 'Data not found'});
            
            if(action === 'approve') {
                if(tx.status !== 'approved') {
                    tx.status = 'approved';
                    if(!userProfiles[tx.user]) userProfiles[tx.user] = { balance: 0 };
                    if(!userProfiles[tx.user].balance) userProfiles[tx.user].balance = 0;
                    userProfiles[tx.user].balance += tx.amount;
                    saveUserProfiles();
                }
            } else if (action === 'reject') {
                tx.status = 'rejected';
            }
            saveTopups();
            send({success:true});
        });
    }

    // --- LOTTERY SYSTEM (UPDATED: USE BALANCE) ---
    else if (url.pathname === '/api/lottery' && req.method === 'GET') {
        send({ success: true, data: lotteryDB });
    }
    else if (url.pathname === '/api/lottery/create' && req.method === 'POST') {
        const s = getSessionInfo(req); if (!s || s.role !== 'admin') return send({success:false, message:'Akses Ditolak'}, 403);
        let b=''; req.on('data', c=>b+=c); req.on('end', () => {
            const { title, img, target } = JSON.parse(b);
            const newItem = {
                id: Date.now(),
                title, img, target: parseInt(target),
                collected: 0,
                winner: null,
                status: 'active',
                participants: [] 
            };
            lotteryDB.push(newItem);
            saveLottery();
            send({success:true, message:'Undian dibuat'});
        });
    }
    else if (url.pathname === '/api/lottery/join' && req.method === 'POST') {
        const s = getSessionInfo(req); if (!s) return send({success:false}, 401);
        let b=''; req.on('data', c=>b+=c); req.on('end', () => {
            const { id, amount, phone } = JSON.parse(b);
            const nominal = parseInt(amount);
            
            // 1. Check Lottery Status
            const item = lotteryDB.find(x => x.id === id);
            if (!item || item.status !== 'active') return send({success:false, message:'Undian tidak aktif'});
            
            // 2. Check User Balance
            const userProfile = userProfiles[s.user];
            if(!userProfile || !userProfile.balance || userProfile.balance < nominal) {
                return send({success:false, message: 'Saldo tidak cukup. Silakan Top Up dahulu.'});
            }

            // 3. Process Transaction
            // Deduct Balance
            userProfile.balance -= nominal;
            userProfile.phone = phone; // Update phone info
            saveUserProfiles();

            // Add to Lottery (Auto Approved because paid with wallet)
            item.participants.push({
                user: s.user,
                phone: phone,
                amount: nominal,
                status: 'approved', // Auto approved
                date: Date.now(),
                trxId: crypto.randomBytes(4).toString('hex').toUpperCase()
            });
            item.collected += nominal;
            
            saveLottery();
            send({success:true, message:'Berhasil bergabung! Saldo terpotong.'});
        });
    }
    else if (url.pathname === '/api/lottery/spin' && req.method === 'POST') {
        const s = getSessionInfo(req); if (!s || s.role !== 'admin') return send({success:false}, 403);
        let b=''; req.on('data', c=>b+=c); req.on('end', () => {
            const { id } = JSON.parse(b);
            const item = lotteryDB.find(x => x.id === id);
            if (!item) return send({success:false});

            const validParticipants = item.participants.filter(p => p.status === 'approved');
            if (validParticipants.length === 0) return send({success:false, message:'Belum ada peserta valid'});
            
            const randIndex = Math.floor(Math.random() * validParticipants.length);
            const winner = validParticipants[randIndex];
            
            item.winner = `${winner.user} (${winner.phone})`;
            item.status = 'ended';
            
            saveLottery();
            send({success:true, winner: item.winner});
        });
    }
    else if (url.pathname === '/api/lottery/delete' && req.method === 'POST') {
        const s = getSessionInfo(req); if (!s || s.role !== 'admin') return send({success:false}, 403);
        let b=''; req.on('data', c=>b+=c); req.on('end', () => {
            const { id } = JSON.parse(b);
            lotteryDB = lotteryDB.filter(x => x.id !== id);
            saveLottery();
            send({success:true});
        });
    }
    
    else if (url.pathname === '/api/lottery/recreate' && req.method === 'POST') {
        const s = getSessionInfo(req); if (!s || s.role !== 'admin') return send({success:false}, 403);
        let b=''; req.on('data', c=>b+=c); req.on('end', () => {
            const { id } = JSON.parse(b);
            const oldItem = lotteryDB.find(x => x.id === id);
            
            if (!oldItem) return send({success:false, message:'Data tidak ditemukan'});

            // Buat item baru berdasarkan data lama (Reset saldo & peserta)
            const newItem = {
                id: Date.now(),
                title: oldItem.title,
                img: oldItem.img,
                target: oldItem.target,
                collected: 0,
                winner: null,
                status: 'active',
                participants: []
            };
            
            lotteryDB.push(newItem);
            saveLottery();
            send({success:true, message: 'Undian berhasil dibuat ulang'});
        });
    }

    // --- OTHER FEATURES ---
    else if (url.pathname === '/api/data') {
        const session = getSessionInfo(req); if (!session) return send({}, 401);
        send({ user: session.user, role: session.role, sessions: getSessions(), meta: botsMeta, activeBots: Array.from(activeBots.keys()) });
    }
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
    else if (url.pathname === '/api/download' && req.method === 'POST') {
        const session = getSessionInfo(req); if (!session) return send({}, 401);
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', async () => {
            const { url, type } = JSON.parse(body);
            const data = await fetchMediaData(url, type);
            send(data ? {success:true, data} : {success:false, message: 'Gagal'});
        });
    }
    else if (url.pathname === '/api/add' && req.method === 'POST') {
        const session = getSessionInfo(req); if (!session) return send({}, 401);
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            const {phone} = JSON.parse(body);
            send(addSession(phone, session.user));
        });
    }
    else if (url.pathname.startsWith('/api/code/')) {
        if (!isAuthenticated(req)) return send({}, 401);
        send({code: pairingCodes.get(url.pathname.split('/').pop()) || 'WAITING'});
    }
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

let tunnelProcess = null;
function startTunnel() {
    try { require('child_process').execSync('pkill cloudflared'); } catch {}
    console.log(`\x1b[36m[TUNNEL]\x1b[0m Starting Cloudflare Tunnel → http://localhost:${PORT}`);
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    tunnelProcess.stderr.on('data', (data) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match) {
            const publicUrl = match[0];
            console.log(`\x1b[32m[TUNNEL]\x1b[0m PUBLIC URL: ${publicUrl}`);
            updateCloudUrl(publicUrl);
        }
    });
    tunnelProcess.on('close', (code) => { setTimeout(startTunnel, 5000); });
}

// ====================================================
// 🚀 START SERVER
// ====================================================
const DEFAULT_PORT = process.env.PORT ? Number(process.env.PORT) : 0;
server.listen(DEFAULT_PORT, () => {
    PORT = server.address().port;
    console.log('\x1b[32m%s\x1b[0m', '====================================');
    console.log(`\x1b[33m[SERVER]\x1b[0m Running on port ${PORT}`);
    console.log('\x1b[32m%s\x1b[0m', '====================================');
    startTunnel();
});
