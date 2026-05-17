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
    const last10 = velas.slice(-10);
    const sma = last10.reduce((sum, v) => sum + v.close, 0) / 10;
    let crosses = 0;
    for(let i=1; i<last10.length; i++) {
        if((last10[i-1].close < sma && last10[i].close >= sma) || (last10[i-1].close > sma && last10[i].close <= sma)) {
            crosses++;
        }
    }
    // Si cruza la media 2 o más veces en 10 velas, está rebotando (lateral). Si no cruza o cruza solo 1 vez, es tendencia pura.
    return crosses >= 2;
};

const iqOptionExpired = (m) => {
    let d = new Date();
    if (d.getSeconds() > 30) m += 1;
    d.setMinutes(d.getMinutes() + m); d.setSeconds(0); d.setMilliseconds(0);
    return Math.floor(d.getTime() / 1000);
};

const updateScannedAssets = (uid, session, assetName, rsi, cci, progress = 0) => {
    if (!session.scannedAssets) session.scannedAssets = [];
    const cleanName = assetName.replace('front.', '').replace('binary-', '').replace('-OTC', ' (OTC)').toUpperCase();
    const idx = session.scannedAssets.findIndex(a => a.asset === cleanName);
    const res = { asset: cleanName, rsi, cci, progress, ts: Date.now() };
    if (idx !== -1) session.scannedAssets[idx] = res; else session.scannedAssets.push(res);
};

// --- SISTEMA DE MEMORIA / MACHINE LEARNING LITE ---
const assetMemory = new Map();
const getAssetLimits = (asset) => {
    if (!assetMemory.has(asset)) assetMemory.set(asset, { rsiCall: 20, rsiPut: 80, cciCall: -150, cciPut: 150 });
    return assetMemory.get(asset);
};
const punishAsset = (asset, side) => {
    const limits = getAssetLimits(asset);
    if (side === 'call') {
        limits.rsiCall = Math.max(5, limits.rsiCall - 3);
        limits.cciCall = Math.max(-300, limits.cciCall - 20);
    } else {
        limits.rsiPut = Math.min(95, limits.rsiPut + 3);
        limits.cciPut = Math.min(300, limits.cciPut + 20);
    }
};
const rewardAsset = (asset, side) => {
    const limits = getAssetLimits(asset);
    if (side === 'call') {
        limits.rsiCall = Math.min(20, limits.rsiCall + 1);
        limits.cciCall = Math.min(-150, limits.cciCall + 5);
    } else {
        limits.rsiPut = Math.max(80, limits.rsiPut - 1);
        limits.cciPut = Math.max(150, limits.cciPut - 5);
    }
};

// --- MOTOR BOT (TOP LEVEL) ---

function iniciarMotorBot(uid, session, balanceId, amount) {
    if (session.isLooping) return;
    session.isLooping = true;
    const api = session.api;
    const deadAssets = new Map();

    const fetchCandlesSafe = (activeId) => {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 2000);
            api.getCandles(activeId, 60, 200, Date.now())
                .then(velas => {
                    clearTimeout(timeout);
                    if (velas && velas.length) {
                        resolve(velas.sort((a,b)=>a.from-b.from));
                    } else {
                        resolve(null);
                    }
                })
                .catch(() => {
                    clearTimeout(timeout);
                    resolve(null);
                });
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

        // Inyectar placeholders si está vacío
        if (session.scannedAssets.length === 0) {
            ACTIVOS.forEach(id => {
                const name = knownMarkets.get(id) || `ID:${id}`;
                updateScannedAssets(uid, session, name, '--', '--', 0);
            });
            io.to(uid).emit('scan_telemetry', { results: session.scannedAssets });
        }

        const BATCH_SIZE = 15;
        
        for (let i = 0; i < ACTIVOS.length; i += BATCH_SIZE) {
            if (!session.botActivo || s.trades >= s.cycles) break;
            
            const batch = ACTIVOS.slice(i, i + BATCH_SIZE);
            s.phase = `🔍 Analizando Lote [${i+1} a ${Math.min(i+BATCH_SIZE, ACTIVOS.length)} de ${ACTIVOS.length}]...`;
            io.to(uid).emit('live_bot_update', { phase: s.phase, trades: s.trades, w: s.w, l: s.l });

            await Promise.all(batch.map(async (id, index) => {
                if (!session.botActivo || s.trades >= s.cycles) return;
                
                await new Promise(r => setTimeout(r, index * 35)); // Desfase anti-spam para el broker
                
                const name = knownMarkets.get(id) || `ID:${id}`;

                try {
                    const velas = await fetchCandlesSafe(id);
                    if (!velas || velas.length < 15) return; // Si falla por rate-limit, reintenta el próximo ciclo sin matarlo

                    const rsi = calcularRSI(velas, 6);
                    const cci = calcularCCI(velas, 14);
                    const last20 = velas.slice(-20);
                    const maxH = Math.max(...last20.map(v => v.max || v.high || v.close));
                    const minL = Math.min(...last20.map(v => v.min || v.low || v.close));
                    const currP = velas[velas.length-1].close;
                    const h_dist = maxH - minL;
                    const atR = h_dist === 0 || currP >= maxH - (h_dist * 0.35);
                    const atS = h_dist === 0 || currP <= minL + (h_dist * 0.35);

                    const rScore = rsi >= 80 || rsi <= 20 ? 100 : Math.min(100, (Math.abs(rsi-50)/30)*100);
                    const cScore = Math.abs(cci) >= 150 ? 100 : Math.min(100, (Math.abs(cci)/150)*100);
                    const prog = ((rScore + cScore)/2).toFixed(0);
                    
                    updateScannedAssets(uid, session, name, rsi.toFixed(1), cci.toFixed(1), prog);
                    
                    const limits = getAssetLimits(name);
                    let dir = null;
                    const isLat = esLateralizado(velas);
                    if (rsi <= limits.rsiCall && cci <= limits.cciCall && atS && isLat) dir = 'call';
                    if (rsi >= limits.rsiPut && cci >= limits.cciPut && atR && isLat)  dir = 'put';

                    if (!dir) {
                        let near = null;
                        if (rsi <= limits.rsiCall + 5 && cci <= limits.cciCall + 50 && atS && isLat) near = 'call';
                        if (rsi >= limits.rsiPut - 5 && cci >= limits.cciPut - 50 && atR && isLat) near = 'put';
                        if (near) {
                            io.to(uid).emit('near_miss', {
                                asset: name, rsi: rsi.toFixed(1), cci: cci.toFixed(1), side: near.toUpperCase(),
                                reason: 'Cerca de Zona Extrema Dinámica'
                            });
                        }
                    }

                    if (dir) {
                        // Reservar cupo de operación para evitar colisiones en concurrencia
                        if (s.trades >= s.cycles) return;
                        s.trades++;

                        if (new Date().getSeconds() < 58) {
                            s.phase = `⏳ ESPERANDO CIERRE VELA ${name}...`;
                            io.to(uid).emit('live_bot_update', { phase: s.phase, trades: s.trades, w: s.w, l: s.l });
                            await new Promise(r => setTimeout(r, (58 - new Date().getSeconds()) * 1000));
                        }
                        
                        if (!session.botActivo) { s.trades--; return; } // Rollback si el bot se apagó mientras esperaba

                        s.phase = `🎯 ${dir.toUpperCase()} → ${name}`;
                        io.to(uid).emit('live_bot_update', { phase: s.phase, trades: s.trades, w: s.w, l: s.l });
                        
                        try {
                            let entryPrice = currP;
                            // RE-FETCH EXACT PRICE JUST BEFORE ORDER TO AVOID 58-SECOND SLIPPAGE
                            try {
                                const vN = await api.getCandles(id, 60, 2, Date.now());
                                if (vN && vN.length>0) entryPrice = vN[vN.length-1].close;
                            } catch(e) {}
                            
                            const order = await api.sendOrderBinary(id, dir, iqOptionExpired(1), balanceId, 0, amount || s.amount);
                            const ts = { id: Date.now(), asset: name, side: dir.toUpperCase(), entry: entryPrice, rsi: rsi.toFixed(1), cci: cci.toFixed(1), time: new Date().toLocaleTimeString(), result: 'PROCESANDO...', color: 'text-blue-400' };
                            io.to(uid).emit('trade_executed', ts);
                            s.report.push(ts);
                            
                            setTimeout(async () => {
                                try {
                                    let vC = await fetchCandlesSafe(id, 60, 5);
                                    let closePrice = entryPrice; // Default a empate
                                    
                                    if (vC && vC.length > 0) {
                                        vC = vC.sort((a,b)=>a.from-b.from);
                                        // Obtener el cierre de la vela anterior a la actual (la vela que expiró)
                                        closePrice = vC.length > 1 ? vC[vC.length-2].close : vC[vC.length-1].close;
                                    }

                                    const win = dir === 'call' ? closePrice > entryPrice : closePrice < entryPrice;
                                    
                                    if (win) {
                                        s.w++;
                                        rewardAsset(name, dir);
                                    } else {
                                        s.l++;
                                        punishAsset(name, dir);
                                    }

                                    ts.result = win ? 'GANADA ✅' : 'PERDIDA ❌';
                                    ts.color = win ? 'text-green-400' : 'text-red-400';
                                    io.to(uid).emit('live_trade_result', ts);
                                    io.to(uid).emit('live_bot_update', { phase: win ? `Resultado: ${ts.result}` : `🧠 Bot aprendió del error en ${name}`, trades: s.trades, w: s.w, l: s.l });
                                    
                                    // Actualizar balance con delay de 2s para que IQ Option liquide el trade
                                    await new Promise(r => setTimeout(r, 2000));
                                    api.getProfile().then(profile => {
                                        let uD = profile.balances?.find(b => b.type === 4)?.amount || 0;
                                        let uR = profile.balances?.find(b => b.type === 1)?.amount || 0;
                                        if (session.balances) { session.balances.demo = uD; session.balances.real = uR; }
                                        io.to(uid).emit('balance_sync', { demo: Number(uD).toFixed(2), real: Number(uR).toFixed(2) });
                                    }).catch(()=>{});

                                } catch(e) { 
                                    // Error de red al evaluar: marcamos resultado como PROCESANDO para no contar doble
                                    ts.result='PROCESANDO...';
                                    ts.color='text-yellow-400';
                                    io.to(uid).emit('live_trade_result', ts); 
                                }
                                
                                s.completedTrades++;
                                if (s.completedTrades >= s.cycles) {
                                    session.botActivo = false;
                                    session.isLooping = false;
                                    io.to(uid).emit('live_bot_finished', { report: s.report, w: s.w, l: s.l, trades: s.trades });
                                }
                            }, 65000);
                        } catch(e) { s.trades--; /* Rollback on failure */ }
                    }
                } catch(e) {}
            }));
            
            // Refrescar el UI con los resultados del lote
            io.to(uid).emit('scan_telemetry', { results: session.scannedAssets });
            await new Promise(r => setTimeout(r, 400)); // Breve pausa entre lotes para que el websocket respire
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
                if (session.scannedAssets && session.scannedAssets.length > 0) {
                    socket.emit('scan_telemetry', { results: session.scannedAssets });
                }
                socket.emit('live_bot_update', { phase: session.botState.phase, trades: session.botState.trades, w: session.botState.w, l: session.botState.l });
                
                if (!session.isLooping) {
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
                    
                    const exploit = (obj, depth = 0) => {
                        if (!obj || depth > 5) return;
                        if ((obj.active_id || obj.id) && (obj.name || obj.active_name)) {
                            let n = (obj.name || obj.active_name).toLowerCase();
                            // SOLO ACEPTAR ACTIVOS OTC (divisas, acciones, cripto)
                            if (n.includes('otc')) {
                                let clean = (obj.name || obj.active_name).replace('front.', '').replace('binary-', '').replace('-OTC', ' (OTC)').toUpperCase();
                                knownMarkets.set(Number(obj.active_id || obj.id), clean);
                            }
                        }
                        for (const k in obj) if (typeof obj[k] === 'object') exploit(obj[k], depth + 1);
                    };
                    exploit(initData);
                    console.log(`[MAP] Activos OTC descubiertos: ${knownMarkets.size}`);
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
                                    if (priceList.length === symbols.length) io.to(socket.uid).emit('price_multi_update', { prices: priceList });
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
        const session = userSessions.get(socket.uid);
        if (!session) return;
        if (session.botActivo) { session.botActivo = false; if (session.botTimeout) clearTimeout(session.botTimeout); }
        const { account, cycles, amount } = config;
        const profile = session.profile;
        const typeId = account === 'real' ? 1 : 4;
        const balanceSelect = (profile.balances || []).find(b => b.type === typeId);
        const balanceId = balanceSelect ? balanceSelect.id : profile.balance_id;
        session.botState = { active: true, phase: 'Iniciando...', trades: 0, w: 0, l: 0, account, amount: Number(amount), cycles: Number(cycles), report: [], completedTrades: 0 };
        session.botActivo = true; session.scannedAssets = []; session.isLooping = false;
        iniciarMotorBot(socket.uid, session, balanceId, Number(amount));
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 TradeBot PRO v8.5 operativo en puerto ${PORT}`);
});
