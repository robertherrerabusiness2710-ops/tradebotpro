import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { 
    IQOptionApi, 
    IQOptionMarket, 
    IQOptionCurrencyType 
} = require('iq-option-client');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.static(path.join(__dirname, 'dist')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const userSessions = new Map();
const knownMarkets = new Map();

// --- HELPERS TRADING (TOP LEVEL) ---

const calcularRSI = (velas, periodos = 6) => {
    if (velas.length < periodos + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= periodos; i++) {
        const diff = velas[i].close - velas[i - 1].close;
        if (diff > 0) gains += diff; else losses -= diff;
    }
    gains /= periodos; losses /= periodos;
    for (let i = periodos + 1; i < velas.length; i++) {
        const diff = velas[i].close - velas[i - 1].close;
        let cG = 0, cL = 0;
        if (diff > 0) cG = diff; else cL = -diff;
        gains = (gains * (periodos - 1) + cG) / periodos;
        losses = (losses * (periodos - 1) + cL) / periodos;
    }
    if (losses === 0) return 100;
    return 100 - (100 / (1 + (gains / losses)));
};

const calcularCCI = (velas, periodos = 14) => {
    if (velas.length < periodos) return 0;
    const slice = velas.slice(-periodos);
    const tps = slice.map(c => (c.max + c.min + c.close) / 3);
    const sma = tps.reduce((a, b) => a + b, 0) / periodos;
    const md = tps.reduce((a, b) => a + Math.abs(b - sma), 0) / periodos;
    return md === 0 ? 0 : (tps[tps.length - 1] - sma) / (0.015 * md);
};

const esLateralizado = (velas) => {
    if (velas.length < 10) return true;
    const r1 = calcularRSI(velas.slice(0, -1), 6);
    const r2 = calcularRSI(velas.slice(0, -2), 6);
    const rA = calcularRSI(velas, 6);
    if (rA >= 90 && r1 >= 90 && r2 >= 90) return false;
    if (rA <= 10 && r1 <= 10 && r2 <= 10) return false;
    const u4 = velas.slice(-4);
    let v = 0, r = 0;
    u4.forEach(x => { if (x.close > x.open) v++; else r++; });
    if (v >= 4 || r >= 4) return false;
    return true;
};

const iqOptionExpired = (m) => {
    let d = new Date();
    if (d.getSeconds() > 30) m += 1;
    d.setMinutes(d.getMinutes() + m); d.setSeconds(0); d.setMilliseconds(0);
    return Math.floor(d.getTime() / 1000);
};

const updateScannedAssets = (uid, session, assetName, rsi, cci, progress = 0) => {
    if (!session.scannedAssets) session.scannedAssets = [];
    const idx = session.scannedAssets.findIndex(a => a.asset === assetName);
    const res = { asset: assetName, rsi, cci, progress, ts: Date.now() };
    if (idx !== -1) session.scannedAssets[idx] = res; else session.scannedAssets.push(res);
};

// --- MOTOR BOT (TOP LEVEL) ---

function iniciarMotorBot(uid, session, balanceId, amount) {
    if (session.isLooping) return;
    session.isLooping = true;
    const api = session.api;
    const deadAssets = new Map();

    const fetchCandlesSafe = (activeId) => {
        return new Promise((resolve) => {
            const reqId = Date.now() + Math.floor(Math.random() * 1000);
            const t = setTimeout(() => { api.iqOptionWs.removeListener('message', h); resolve(null); }, 5000);
            const h = (m) => {
                try {
                    const js = JSON.parse(m.toString());
                    if (js.name === 'candles' && js.request_id === String(reqId)) {
                        clearTimeout(t); api.iqOptionWs.removeListener('message', h);
                        resolve((js.msg.data || []).sort((a,b)=>a.from-b.from));
                    }
                } catch(e){}
            };
            api.iqOptionWs.on('message', h);
            api.iqOptionWs.send('get-candles', { active_id: activeId, size: 60, to: Math.floor(Date.now()/1000), count: 200 }, reqId);
        });
    };

    const loop = async () => {
        const s = session.botState;
        if (!s || !session.botActivo) { session.isLooping = false; return; }
        if (s.trades >= s.cycles) {
            session.botActivo = false; session.isLooping = false;
            io.to(uid).emit('live_bot_finished', { trades: s.trades, w: s.w, l: s.l, report: s.report });
            return;
        }

        const ACTIVOS = [];
        knownMarkets.forEach((name, id) => ACTIVOS.push(id));
        if (ACTIVOS.length === 0) [816, 817, 1072, 1073, 1074, 994, 993, 1000, 1001, 1002, 1003, 1004, 1005, 76, 77, 78, 81].forEach(id => ACTIVOS.push(id));

        for (let i = 0; i < ACTIVOS.length; i++) {
            if (!session.botActivo || s.trades >= s.cycles) break;
            const id = ACTIVOS[i];
            const name = knownMarkets.get(id) || `ID:${id}`;
            if ((deadAssets.get(id) || 0) >= 3) continue;

            s.phase = `🔍 [${i+1}/${ACTIVOS.length}] ${name}...`;
            io.to(uid).emit('live_bot_update', { phase: s.phase, trades: s.trades, w: s.w, l: s.l });

            try {
                const velas = await fetchCandlesSafe(id);
                if (!velas || velas.length < 15) { deadAssets.set(id, (deadAssets.get(id)||0)+1); continue; }
                deadAssets.set(id, 0);

                const rsi = calcularRSI(velas, 6);
                const cci = calcularCCI(velas, 14);
                const last20 = velas.slice(-20);
                const maxH = Math.max(...last20.map(v => v.max || v.high || v.close));
                const minL = Math.min(...last20.map(v => v.min || v.low || v.close));
                const currP = velas[velas.length-1].close;
                const h_dist = maxH - minL;
                const atR = h_dist === 0 || currP >= maxH - (h_dist * 0.15);
                const atS = h_dist === 0 || currP <= minL + (h_dist * 0.15);

                const rScore = rsi >= 90 || rsi <= 10 ? 100 : Math.min(100, (Math.abs(rsi-50)/40)*100);
                const cScore = Math.abs(cci) >= 200 ? 100 : Math.min(100, (Math.abs(cci)/200)*100);
                const prog = ((rScore + cScore)/2).toFixed(0);
                updateScannedAssets(uid, session, name, rsi.toFixed(1), cci.toFixed(1), prog);
                io.to(uid).emit('scan_telemetry', { results: session.scannedAssets });

                let dir = null;
                if (rsi <= 10.0 && cci <= -200.0 && atS) dir = 'call';
                if (rsi >= 90.0 && cci >= 200.0 && atR)  dir = 'put';
                if (dir && !esLateralizado(velas)) dir = null;

                if (dir) {
                    if (new Date().getSeconds() < 58) {
                        s.phase = `⏳ ESPERANDO CIERRE VELA ${name}...`;
                        io.to(uid).emit('live_bot_update', { phase: s.phase, trades: s.trades, w: s.w, l: s.l });
                        await new Promise(r => setTimeout(r, (58 - new Date().getSeconds()) * 1000));
                    }
                    s.phase = `🎯 ${dir.toUpperCase()} → ${name}`;
                    io.to(uid).emit('live_bot_update', { phase: s.phase, trades: s.trades, w: s.w, l: s.l });
                    try {
                        const order = await api.sendOrderBinary(id, dir, iqOptionExpired(1), balanceId, 0, amount || s.amount);
                        const ts = { id: Date.now(), asset: name, side: dir.toUpperCase(), entry: currP, rsi: rsi.toFixed(1), cci: cci.toFixed(1), time: new Date().toLocaleTimeString(), result: 'PROCESANDO...', color: 'text-blue-400' };
                        io.to(uid).emit('trade_executed', ts);
                        s.report.push(ts); s.trades++;
                        setTimeout(async () => {
                            try {
                                let vC = await api.getCandles(id, 60, 4, Date.now());
                                vC = vC.sort((a,b)=>a.from-b.from);
                                const win = dir === 'call' ? vC[vC.length-2].close > vC[vC.length-3].close : vC[vC.length-2].close < vC[vC.length-3].close;
                                if (win) s.w++; else s.l++;
                                ts.result = win ? 'GANADA ✅' : 'PERDIDA ❌';
                                ts.color = win ? 'text-green-400' : 'text-red-400';
                                io.to(uid).emit('live_trade_result', ts);
                            } catch(e) { ts.result='FINALIZADA'; io.to(uid).emit('live_trade_result', ts); }
                        }, 65000);
                    } catch(e) {}
                }
            } catch(e) {}
            await new Promise(r => setTimeout(r, 200));
        }
        if (session.botActivo && s.trades < s.cycles) {
            s.phase = `⏳ Recargando en 8s... (${s.trades}/${s.cycles})`;
            io.to(uid).emit('live_bot_update', { phase: s.phase, trades: s.trades, w: s.w, l: s.l });
            session.botTimeout = setTimeout(loop, 8000);
        } else { session.isLooping = false; }
    };
    loop();
}

// --- SOCKET SERVER LOGIC ---

io.on('connection', (socket) => {
    console.log('🔌 Cliente Conectado:', socket.id);

    socket.on('auth_link', (uid) => {
        socket.join(uid);
        socket.uid = uid;
        const session = userSessions.get(uid);
        if (session && session.profile) {
            socket.emit('iq_connected', { name: session.profile.name });
            if (session.balances) {
                socket.emit('balance_sync', { demo: Number(session.balances.demo).toFixed(2), real: Number(session.balances.real).toFixed(2) });
            }
            if (session.botActivo && session.botState) {
                if (session.scannedAssets) {
                    socket.emit('scan_init', { assets: session.scannedAssets });
                    socket.emit('scan_telemetry', { results: session.scannedAssets });
                }
                socket.emit('live_bot_update', { phase: session.botState.phase, trades: session.botState.trades, w: session.botState.w, l: session.botState.l });
                if (!session.isLooping) {
                    // Recuperar balanceId para el motor
                    const profile = session.profile;
                    const account = session.botState.account;
                    const typeId = account === 'real' ? 1 : 4;
                    const balanceSelect = (profile.balances || []).find(b => b.type === typeId);
                    const balanceId = balanceSelect ? balanceSelect.id : profile.balance_id;
                    iniciarMotorBot(uid, session, balanceId, session.botState.amount);
                }
            }
        }
    });

    socket.on('connect_iq', async (data) => {
        const { uid, email, password } = data;
        try {
            const api = new IQOptionApi(email, password);
            const profile = await api.connectAsync();
            if (profile) {
                let userDemo = profile.balances?.find(b => b.type === 4)?.amount || 0;
                let userReal = profile.balances?.find(b => b.type === 1)?.amount || 0;
                const session = { api, profile, balances: { demo: userDemo, real: userReal }, botActivo: false, isLooping: false };
                userSessions.set(uid, session);
                socket.emit('iq_connected', { name: profile.name });
                socket.emit('balance_sync', { demo: Number(userDemo).toFixed(2), real: Number(userReal).toFixed(2) });

                // Mapeo inicial de activos
                try {
                    const initData = await api.getInitializationData();
                    const TARGETS = ['fr 40', 'ger 30', 'hk 33', 'us 500', 'amazon', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'intel', 'tesla', 'google', 'netflix', 'apple'];
                    const FORBIDDEN = ['eur/','gbp/','usd/cad','usd/jpy'];
                    
                    const exploit = (obj, depth = 0) => {
                        if (!obj || depth > 5) return;
                        if ((obj.active_id || obj.id) && (obj.name || obj.active_name)) {
                            let n = (obj.name || obj.active_name).toLowerCase();
                            if (FORBIDDEN.some(f => n.includes(f))) return;
                            if (TARGETS.some(t => n.includes(t)) && !knownMarkets.has(Number(obj.active_id || obj.id))) {
                                let clean = (obj.name || obj.active_name).replace('front.', '').replace('binary-', '').replace('-OTC', ' (OTC)').toUpperCase();
                                knownMarkets.set(Number(obj.active_id || obj.id), clean);
                            }
                        }
                        for (const k in obj) if (typeof obj[k] === 'object') exploit(obj[k], depth + 1);
                    };
                    exploit(initData);
                } catch(e){}

                // Monitor de precios
                const mainLoop = setInterval(() => {
                    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
                    const priceList = [];
                    symbols.forEach(symbol => {
                        https.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, (res) => {
                            let d = ''; res.on('data', c => d += c);
                            res.on('end', () => {
                                try {
                                    const j = JSON.parse(d);
                                    priceList.push({ pair: symbol.replace('USDT', ''), price: parseFloat(j.price).toLocaleString('en-US', { minimumFractionDigits: 2 }), timestamp: new Date().toLocaleTimeString() });
                                    if (priceList.length === symbols.length) io.to(uid).emit('price_multi_update', { prices: priceList });
                                } catch(e){}
                            });
                        }).on('error', ()=>{});
                    });
                    // Sync balance
                    socket.emit('balance_sync', { demo: Number(session.balances.demo).toFixed(2), real: Number(session.balances.real).toFixed(2) });
                }, 10000);
                session.mainLoop = mainLoop;
            }
        } catch (err) { socket.emit('iq_error', { msg: err.message }); }
    });

    socket.on('start_live_bot', (config) => {
        const session = userSessions.get(uid);
        if (!session) return;
        if (session.botActivo) { session.botActivo = false; if (session.botTimeout) clearTimeout(session.botTimeout); }
        const { account, cycles, amount } = config;
        const profile = session.profile;
        const typeId = account === 'real' ? 1 : 4;
        const balanceSelect = (profile.balances || []).find(b => b.type === typeId);
        const balanceId = balanceSelect ? balanceSelect.id : profile.balance_id;
        session.botState = { active: true, phase: 'Iniciando...', trades: 0, w: 0, l: 0, account, amount: Number(amount), cycles: Number(cycles), report: [] };
        session.botActivo = true; session.scannedAssets = []; session.isLooping = false;
        iniciarMotorBot(socket.uid, session, balanceId, Number(amount));
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 TradeBot PRO v8.5 operativo en puerto ${PORT}`);
});
