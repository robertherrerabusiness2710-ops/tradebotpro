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
    const tps = slice.map(c => ((c.max || c.high || c.close) + (c.min || c.low || c.close) + c.close) / 3);
    const sma = tps.reduce((a, b) => a + b, 0) / periodos;
    const md = tps.reduce((a, b) => a + Math.abs(b - sma), 0) / periodos;
    return md === 0 ? 0 : (tps[tps.length - 1] - sma) / (0.015 * md);
};

const esLateralizado = (velas) => {
    if (velas.length < 15) return false;
    const last15 = velas.slice(-15);
    const sma = last15.reduce((sum, v) => sum + v.close, 0) / 15;

    let crosses = 0;
    for (let i = 1; i < last15.length; i++) {
        if ((last15[i-1].close < sma && last15[i].close >= sma) ||
            (last15[i-1].close > sma && last15[i].close <= sma)) {
            crosses++;
        }
    }

    const maxH = Math.max(...last15.map(v => v.max || v.high || v.close));
    const minL = Math.min(...last15.map(v => v.min || v.low || v.close));
    const totalRange = maxH - minL;
    
    if (totalRange === 0) return true;

    // Desplazamiento neto entre la vela 1 y la 15
    const netMovement = Math.abs(last15[last15.length-1].close - last15[0].close);
    
    // Si el desplazamiento neto es mayor al 40% del rango total, ES TENDENCIA.
    // Para ser lateral, el precio debe terminar cerca de donde empezó, oscilando en el medio.
    const isRanging = (netMovement / totalRange) <= 0.4;

    // Mínimo 3 cruces de SMA y desplazamiento neto pequeño
    return crosses >= 3 && isRanging;
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

// --- SISTEMA DE MEMORIA / MACHINE LEARNING LITE (PERSISTENTE) ---
const MEMORY_FILE = path.join(__dirname, 'asset_memory.json');
const assetMemory = new Map();

// Cargar memoria persistida del disco al iniciar
try {
    if (fs.existsSync(MEMORY_FILE)) {
        const saved = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        for (const [k, v] of Object.entries(saved)) assetMemory.set(k, v);
        console.log(`[ML] Memoria cargada: ${assetMemory.size} activos recordados`);
    }
} catch(e) { console.log('[ML] Sin memoria previa, comenzando fresco'); }

const saveMemory = () => {
    try {
        const obj = {};
        assetMemory.forEach((v, k) => obj[k] = v);
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(obj, null, 2));
    } catch(e) {}
};

const getAssetLimits = (asset) => {
    if (!assetMemory.has(asset)) assetMemory.set(asset, { rsiCall: 20, rsiPut: 80, cciCall: -150, cciPut: 150, wins: 0, losses: 0 });
    return assetMemory.get(asset);
};

// --- SISTEMA DE HORARIOS EFECTIVOS ---
const TIME_MEMORY_FILE = path.join(__dirname, 'time_memory.json');
const timeMemory = {};

try {
    if (fs.existsSync(TIME_MEMORY_FILE)) {
        Object.assign(timeMemory, JSON.parse(fs.readFileSync(TIME_MEMORY_FILE, 'utf8')));
    }
} catch(e) {}

const saveTimeMemory = () => {
    try { fs.writeFileSync(TIME_MEMORY_FILE, JSON.stringify(timeMemory, null, 2)); } catch(e) {}
};

const recordTradeTime = (isWin) => {
    const hour = new Date().getHours().toString();
    if (!timeMemory[hour]) timeMemory[hour] = { wins: 0, losses: 0 };
    if (isWin) timeMemory[hour].wins++;
    else timeMemory[hour].losses++;
    saveTimeMemory();
};
const punishAsset = (asset, side) => {
    const limits = getAssetLimits(asset);
    limits.losses = (limits.losses || 0) + 1;
    if (side === 'call') {
        limits.rsiCall = Math.max(5, limits.rsiCall - 3);
        limits.cciCall = Math.max(-300, limits.cciCall - 20);
    } else {
        limits.rsiPut = Math.min(95, limits.rsiPut + 3);
        limits.cciPut = Math.min(300, limits.cciPut + 20);
    }
    saveMemory();
    recordTradeTime(false);
};
const rewardAsset = (asset, side) => {
    const limits = getAssetLimits(asset);
    limits.wins = (limits.wins || 0) + 1;
    if (side === 'call') {
        limits.rsiCall = Math.min(20, limits.rsiCall + 1);
        limits.cciCall = Math.min(-150, limits.cciCall + 5);
    } else {
        limits.rsiPut = Math.max(80, limits.rsiPut - 1);
        limits.cciPut = Math.max(150, limits.cciPut - 5);
    }
    saveMemory();
    recordTradeTime(true);
};

// --- MOTOR BOT (TOP LEVEL) ---

// --- MOTOR BOT (TOP LEVEL) ---

const checkCycleCompletion = (uid, session) => {
    const s = session.botState;
    if (!s) return;
    
    // El ciclo termina cuando se han completado y evaluado todas las operaciones colocadas,
    // y además la cantidad de operaciones intentadas alcanzó (o superó) el límite programado.
    const allTradesFinished = s.report.every(t => 
        t.result !== 'PROCESANDO...' && 
        t.result !== 'PROCESANDO VELA... ⏳' &&
        t.result !== 'ENVIANDO A BROKER... 🎯' &&
        t.result !== 'PROCESANDO... 📈' &&
        t.result !== 'EN CURSO 📈'
    );

    if (s.trades >= s.cycles && allTradesFinished) {
        if (!s.finishedFlag) {
            s.finishedFlag = true;
            s.phase = `✅ ¡Ciclo completado con éxito! Efectividad: ${s.trades > 0 ? ((s.w / s.trades) * 100).toFixed(0) : 0}%`;
            io.to(uid).emit('live_bot_finished', { phase: s.phase, trades: s.trades, w: s.w, l: s.l, report: s.report });
        }
    }
};

function iniciarMotorBot(uid, session, balanceId, amount) {
    if (session.isLooping) return;
    session.isLooping = true;
    const api = session.api;
    const deadAssets = new Map();

    const fetchCandlesSafe = (activeId) => {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 4000); // Aumentado de 2s a 4s
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
            // Detener el escáner recursivo, pero NO emitir live_bot_finished aquí!
            // Porque las operaciones colocadas todavía se están resolviendo en segundo plano.
            session.isLooping = false;
            s.phase = `⏳ Esperando cierre de las últimas operaciones...`;
            io.to(uid).emit('live_bot_update', { phase: s.phase, trades: s.trades, w: s.w, l: s.l, report: s.report });
            return;
        }

        let ACTIVOS = [];
        let isFocused = false;
        
        if (session.focusAssets && session.focusAssets.length > 0) {
            session.hunterLoops = (session.hunterLoops || 0) + 1;
            
            // Expiración del Modo Cazador: Si lleva ~2 minutos (45 loops) atascado en los mismos activos,
            // forzamos un reseteo para que dé una vuelta global y no se pierda nuevas oportunidades.
            if (session.hunterLoops > 45) {
                session.focusAssets = [];
                session.hunterLoops = 0;
            } else {
                ACTIVOS = session.focusAssets;
                isFocused = true;
                s.phase = `🎯 Modo Cazador: Enfocado en ${ACTIVOS.length} activos... (Caduca en ${46 - session.hunterLoops})`;
                io.to(uid).emit('live_bot_update', { phase: s.phase, trades: s.trades, w: s.w, l: s.l, report: s.report });
            }
        } else {
            session.hunterLoops = 0; // Reiniciar contador si no hay foco
        }
        
        if (!isFocused) {
            knownMarkets.forEach((name, id) => ACTIVOS.push(id));
            if (ACTIVOS.length === 0) {
                // Crypto OTC + Indices OTC + Acciones OTC + Forex OTC populares
                [816, 817, 818, 819, 820, 821, 822, 823, 824, 825, 
                 1072, 1073, 1074, 1075, 1076, 1077, 1078, 1079, 1080,
                 994, 993, 992, 991, 990, 989, 988, 987, 986, 985,
                 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008,
                 76, 77, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90,
                 3, 4, 5, 6, 7, 8, 9, 10, 36, 37, 38, 39
                ].forEach(id => ACTIVOS.push(id));
            }
        }

        // Inyectar placeholders si está vacío (solo en escaneo global)
        if (!isFocused && session.scannedAssets.length === 0) {
            ACTIVOS.forEach(id => {
                const name = knownMarkets.get(id) || `ID:${id}`;
                updateScannedAssets(uid, session, name, '--', '--', 0);
            });
            io.to(uid).emit('scan_telemetry', { results: session.scannedAssets });
        }

        const BATCH_SIZE = 15;
        let foundNearMissesInThisLoop = [];
        
        for (let i = 0; i < ACTIVOS.length; i += BATCH_SIZE) {
            if (!session.botActivo || s.trades >= s.cycles) break;
            
            const batch = ACTIVOS.slice(i, i + BATCH_SIZE);
            if (!isFocused) {
                s.phase = `🔍 Analizando Lote [${i+1} a ${Math.min(i+BATCH_SIZE, ACTIVOS.length)} de ${ACTIVOS.length}]...`;
                io.to(uid).emit('live_bot_update', { phase: s.phase, trades: s.trades, w: s.w, l: s.l, report: s.report });
            }

            await Promise.all(batch.map(async (id, index) => {
                if (!session.botActivo || s.trades >= s.cycles) return;
                
                await new Promise(r => setTimeout(r, index * 40)); // Desfase anti-spam estricto para evitar baneos del broker
                
                const name = knownMarkets.get(id) || `ID:${id}`;

                try {
                    const velas = await fetchCandlesSafe(id);
                    if (!velas || velas.length < 15) return;

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
                    
                    // LATERALIZACIÓN ES OBLIGATORIA: sin ella la estrategia RSI+CCI falla en tendencia
                    if (isLat) {
                        if (rsi <= limits.rsiCall && cci <= limits.cciCall && atS) dir = 'call';
                        if (rsi >= limits.rsiPut  && cci >= limits.cciPut  && atR)  dir = 'put';
                    }

                    if (!dir && isLat) {
                        // Oportunidades cercanas: umbrales MUY amplios para capturar señales en desarrollo
                        let near = null;
                        // CALL: RSI por debajo del umbral+15 Y CCI por debajo del umbral+100
                        if (rsi <= limits.rsiCall + 15 && cci <= limits.cciCall + 100) near = 'call';
                        // PUT: RSI por encima del umbral-15 Y CCI por encima del umbral-100
                        if (rsi >= limits.rsiPut  - 15 && cci >= limits.cciPut  - 100) near = 'put';
                        if (near) {
                            foundNearMissesInThisLoop.push(id);
                            const distRsi = near === 'call' ? (limits.rsiCall - rsi).toFixed(1) : (rsi - limits.rsiPut).toFixed(1);
                            io.to(uid).emit('near_miss', {
                                asset: name, rsi: rsi.toFixed(1), cci: cci.toFixed(1), side: near.toUpperCase(),
                                reason: `RSI a ${distRsi} pts del umbral`
                            });
                        }
                    }

                    if (dir) {
                        // Reservar cupo de operación para evitar colisiones en concurrencia
                        if (s.trades >= s.cycles) return;
                        s.trades++;

                        // CREAR REGISTRO INMEDIATO EN 'OPERACIONES EN CURSO' PARA EVITAR RETARDOS VISUALES
                        const ts = { 
                            id: Date.now(), 
                            asset: name, 
                            side: dir.toUpperCase(), 
                            entry: currP, 
                            rsi: rsi.toFixed(1), 
                            cci: cci.toFixed(1), 
                            time: new Date().toLocaleTimeString(), 
                            result: 'PROCESANDO VELA... ⏳', 
                            color: 'text-yellow-500 font-black animate-pulse' 
                        };
                        s.report.push(ts);
                        io.to(uid).emit('trade_executed', ts);
                        
                        // Emitir de inmediato para que aparezca en el Dashboard / Strategies en menos de 10ms
                        io.to(uid).emit('live_bot_update', { 
                            phase: `🎯 Señal detectada: ${name}`, 
                            trades: s.trades, 
                            w: s.w, 
                            l: s.l, 
                            report: s.report 
                        });

                        // EJECUTAR EN SEGUNDO PLANO DE FORMA NO-BLOQUEANTE (FIRE-AND-FORGET)
                        (async () => {
                            try {
                                if (new Date().getSeconds() < 58) {
                                    await new Promise(r => setTimeout(r, (58 - new Date().getSeconds()) * 1000));
                                }

                                if (!session.botActivo) { 
                                    s.trades--; 
                                    const indexRep = s.report.indexOf(ts);
                                    if (indexRep !== -1) s.report.splice(indexRep, 1);
                                    io.to(uid).emit('live_bot_update', { phase: `Apagado. Cancelada: ${name}`, trades: s.trades, w: s.w, l: s.l, report: s.report });
                                    return; 
                                }

                                ts.result = `ENVIANDO A BROKER... 🎯`;
                                io.to(uid).emit('live_bot_update', { phase: `🎯 Enviando orden: ${name}`, trades: s.trades, w: s.w, l: s.l, report: s.report });

                                let entryPrice = currP;
                                try {
                                    // Usar fetchCandlesSafe que ya tiene timeout integrado
                                    const vN = await fetchCandlesSafe(id);
                                    if (vN && vN.length > 0) entryPrice = vN[vN.length - 1].close;
                                } catch(e) {}
                                ts.entry = entryPrice;

                                // CRITICO: Envolver la orden en un timeout estricto. Si IQ Option ignora la petición, no nos quedamos colgados.
                                const order = await Promise.race([
                                    api.sendOrderBinary(id, dir, iqOptionExpired(1), balanceId, 0, amount || s.amount),
                                    new Promise((_, rej) => setTimeout(() => rej(new Error('Broker no responde (Timeout)')), 10000))
                                ]);
                                
                                ts.result = `PROCESANDO... 📈`;
                                ts.color = 'text-yellow-400 font-black animate-pulse';
                                io.to(uid).emit('live_bot_update', { phase: `📈 Operación en curso: ${name}`, trades: s.trades, w: s.w, l: s.l, report: s.report });

                                // SINCRONIZAR BALANCE INMEDIATAMENTE TRAS COLOCAR LA ORDEN
                                try {
                                    const profNow = await api.getProfile();
                                    let uD = profNow.balances?.find(b => b.type === 4)?.amount || 0;
                                    let uR = profNow.balances?.find(b => b.type === 1)?.amount || 0;
                                    if (session.balances) { session.balances.demo = uD; session.balances.real = uR; }
                                    io.to(uid).emit('balance_sync', { demo: Number(uD).toFixed(2), real: Number(uR).toFixed(2) });
                                } catch(e) {}

                                const optionId = order.id || order.option_id || order.active_id || `temp-${Date.now()}`;
                                const optionIdStr = String(optionId);

                                const fallbackTimeout = setTimeout(async () => {
                                    const activeTrade = session.activeTrades?.get(optionIdStr);
                                    if (activeTrade && !activeTrade.resolved) {
                                        activeTrade.resolved = true;
                                        try {
                                            let vC = await fetchCandlesSafe(id);
                                            let closePrice = entryPrice;
                                            if (vC && vC.length > 0) {
                                                vC = vC.sort((a,b)=>a.from-b.from);
                                                closePrice = vC.length > 1 ? vC[vC.length-2].close : vC[vC.length-1].close;
                                            }
                                            const win = dir === 'call' ? closePrice > entryPrice : closePrice < entryPrice;
                                            const isEqual = closePrice === entryPrice;

                                            if (win) {
                                                s.w++;
                                                rewardAsset(name, dir);
                                            } else if (!isEqual) {
                                                s.l++;
                                                punishAsset(name, dir);
                                            }

                                            ts.result = win ? 'GANADA ✅' : isEqual ? 'EMPATE 🤝' : 'PERDIDA ❌';
                                            ts.color = win ? 'text-green-400 font-black' : isEqual ? 'text-yellow-400 font-black' : 'text-red-400 font-black';

                                            io.to(uid).emit('live_trade_result', ts);
                                            io.to(uid).emit('live_bot_update', { 
                                                phase: win ? `Resultado: ${ts.result} (F)` : `🧠 Bot aprendió de ${name} (F)`, 
                                                trades: s.trades, 
                                                w: s.w, 
                                                l: s.l,
                                                report: s.report
                                            });

                                            s.completedTrades++;
                                            checkCycleCompletion(uid, session);
                                        } catch(e) {
                                            ts.result = 'PROCESANDO...';
                                            ts.color = 'text-yellow-400 font-black';
                                            io.to(uid).emit('live_trade_result', ts);
                                            s.completedTrades++;
                                            checkCycleCompletion(uid, session);
                                        }
                                        session.activeTrades?.delete(optionIdStr);
                                        
                                        // Sincronizar balance
                                        try {
                                            const prof = await api.getProfile();
                                            let uD = prof.balances?.find(b => b.type === 4)?.amount || 0;
                                            let uR = prof.balances?.find(b => b.type === 1)?.amount || 0;
                                            if (session.balances) { session.balances.demo = uD; session.balances.real = uR; }
                                            io.to(uid).emit('balance_sync', { demo: Number(uD).toFixed(2), real: Number(uR).toFixed(2) });
                                        } catch(e){}
                                    }
                                }, 70000);

                                if (session.activeTrades) {
                                    session.activeTrades.set(optionIdStr, {
                                        ts, dir, name, id, entryPrice, resolved: false, timeout: fallbackTimeout
                                    });
                                }

                            } catch(err) {
                                s.trades--;
                                const idxRep = s.report.indexOf(ts);
                                if (idxRep !== -1) s.report.splice(idxRep, 1);
                                io.to(uid).emit('live_bot_update', { phase: `⚠️ ${name} no disponible, buscando otro activo...`, trades: s.trades, w: s.w, l: s.l, report: s.report });
                                
                                // CRÍTICO: Si el loop ya se detuvo pero aún faltan ciclos, reiniciarlo
                                if (!session.isLooping && session.botActivo && s.trades < s.cycles) {
                                    setTimeout(() => iniciarMotorBot(uid, session, balanceId, amount), 2000);
                                }
                                
                                // Si ya no hay operaciones abiertas y no hay loop, verificar si el ciclo terminó
                                s.completedTrades++;
                                checkCycleCompletion(uid, session);
                            }
                        })();
                    }
                } catch(e) {}
            }));
            
            // Refrescar el UI con los resultados del lote
            io.to(uid).emit('scan_telemetry', { results: session.scannedAssets });
            await new Promise(r => setTimeout(r, 500)); // Breve pausa entre lotes para que el websocket respire
        }
        if (session.botActivo && s.trades < s.cycles) {
            session.focusAssets = foundNearMissesInThisLoop.length > 0 ? [...new Set(foundNearMissesInThisLoop)] : [];
            
            s.phase = session.focusAssets.length > 0 
                ? `⚡ Modo Cazador activado: Recargando en 2s...` 
                : `⏳ Recargando escáner global en 6s...`;
                
            io.to(uid).emit('live_bot_update', { phase: s.phase, trades: s.trades, w: s.w, l: s.l, report: s.report });
            session.botTimeout = setTimeout(loop, session.focusAssets.length > 0 ? 2000 : 6000);
        } else { session.isLooping = false; }
    };
    loop();
}

// --- SOCKET SERVER LOGIC ---

let lastCryptoPrices = [];
const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const fetchPrice = (symbol) => {
    return new Promise((resolve) => {
        https.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (j && j.price) {
                        resolve({ 
                            pair: symbol.replace('USDT', ''), 
                            price: parseFloat(j.price).toLocaleString('en-US', { minimumFractionDigits: 2 }), 
                            timestamp: new Date().toLocaleTimeString() 
                        });
                    } else {
                        resolve(null);
                    }
                } catch(e){ resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
};

const updateGlobalPrices = async () => {
    try {
        const promises = symbols.map(s => fetchPrice(s));
        const results = await Promise.all(promises);
        const priceList = results.filter(r => r !== null);
        if (priceList.length > 0) {
            lastCryptoPrices = priceList;
            io.emit('price_multi_update', { prices: lastCryptoPrices });
        }
    } catch(e){}
};

// Actualizar cada 10 segundos
setInterval(updateGlobalPrices, 10000);
// E iniciar inmediatamente
updateGlobalPrices();

io.on('connection', (socket) => {
    console.log('🔌 Cliente Conectado:', socket.id);

    socket.on('auth_link', (uid) => {
        socket.join(uid);
        socket.uid = uid;
        
        // Enviar precios cargados inmediatamente si existen
        if (lastCryptoPrices.length > 0) {
            socket.emit('price_multi_update', { prices: lastCryptoPrices });
        }

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
                const session = { 
                    api, 
                    profile, 
                    balances: { demo: userDemo, real: userReal }, 
                    botActivo: false, 
                    isLooping: false,
                    activeTrades: new Map()
                };
                userSessions.set(uid, session);
                socket.emit('iq_connected', { name: profile.name });
                socket.emit('balance_sync', { demo: Number(userDemo).toFixed(2), real: Number(userReal).toFixed(2) });

                // REGISTRAR ESCUCHADOR EN VIVO PARA LIQUIDACIÓN DE OPERACIONES EN EL BROKER
                try {
                    api.getIQOptionWs().socket().on('message', async (wsMsgData) => {
                        try {
                            const messageJSON = JSON.parse(wsMsgData.toString());
                            
                            if (messageJSON.name === 'profile' || messageJSON.name === 'balance-changed') {
                                const isBalanceChanged = messageJSON.name === 'balance-changed';
                                const prof = isBalanceChanged ? messageJSON.msg?.current_balance : messageJSON.msg;
                                
                                if (prof) {
                                    let uD = session.balances?.demo || 0;
                                    let uR = session.balances?.real || 0;
                                    
                                    if (prof.balances) {
                                        uD = prof.balances.find(b => b.type === 4)?.amount || uD;
                                        uR = prof.balances.find(b => b.type === 1)?.amount || uR;
                                    } else if (prof.type === 4 || prof.type === 1) { // balance-changed fallback
                                        if (prof.type === 4) uD = prof.amount;
                                        if (prof.type === 1) uR = prof.amount;
                                    }
                                    
                                    if (session.balances) { session.balances.demo = uD; session.balances.real = uR; }
                                    io.to(uid).emit('balance_sync', { demo: Number(uD).toFixed(2), real: Number(uR).toFixed(2) });
                                }
                            }

                            if (messageJSON.name === 'option-closed' || messageJSON.name === 'digital-option-closed') {
                                const msg = messageJSON.msg;
                                if (!msg) return;
                                
                                const optionId = String(msg.option_id || msg.id);
                                let trade = session.activeTrades?.get(optionId);
                                
                                // FALLBACK DE CONEXIÓN EXTREMO: 
                                // Si la orden se colocó pero falló la respuesta de sendOrderBinary,
                                // buscamos una operación coincidente en progreso en s.report.
                                if (!trade && session.botState?.report) {
                                    const activeId = msg.active_id || msg.active;
                                    const assetName = knownMarkets.get(Number(activeId));
                                    if (assetName) {
                                        const sideStr = (msg.direction || msg.side || '').toUpperCase();
                                        const found = session.botState.report.find(t => 
                                            t.asset === assetName && 
                                            t.side === sideStr && 
                                            (t.result === 'PROCESANDO...' || t.result === 'PROCESANDO VELA... ⏳' || t.result === 'ENVIANDO A BROKER... 🎯' || t.result === 'PROCESANDO... 📈' || t.result === 'EN CURSO 📈')
                                        );
                                        if (found) {
                                            trade = {
                                                ts: found,
                                                dir: (msg.direction || msg.side || '').toLowerCase(),
                                                name: assetName,
                                                resolved: false
                                            };
                                        }
                                    }
                                }
                                
                                if (trade && !trade.resolved) {
                                    trade.resolved = true;
                                    if (trade.timeout) clearTimeout(trade.timeout);
                                    
                                    const isWin = msg.win === 'win' || msg.result === 'win';
                                    const isEqual = msg.win === 'equal' || msg.result === 'equal';
                                    
                                    const s = session.botState;
                                    if (s) {
                                        if (isWin) {
                                            s.w++;
                                            rewardAsset(trade.name, trade.dir);
                                        } else if (!isEqual) {
                                            s.l++;
                                            punishAsset(trade.name, trade.dir);
                                        }
                                        
                                        trade.ts.result = isWin ? 'GANADA ✅' : isEqual ? 'EMPATE 🤝' : 'PERDIDA ❌';
                                        trade.ts.color = isWin ? 'text-green-400 font-black' : isEqual ? 'text-yellow-400 font-black' : 'text-red-400 font-black';
                                        
                                        io.to(uid).emit('live_trade_result', trade.ts);
                                        io.to(uid).emit('live_bot_update', { 
                                            phase: isWin ? `Resultado: ${trade.ts.result}` : `🧠 Bot aprendió de ${trade.name}`, 
                                            trades: s.trades, 
                                            w: s.w, 
                                            l: s.l,
                                            report: s.report
                                        });
                                        
                                        s.completedTrades++;
                                        checkCycleCompletion(uid, session);
                                    }
                                    session.activeTrades.delete(optionId);
                                    
                                    // Sincronizar balance inmediatamente después de liquidación
                                    try {
                                        const prof = await api.getProfile();
                                        let uD = prof.balances?.find(b => b.type === 4)?.amount || 0;
                                        let uR = prof.balances?.find(b => b.type === 1)?.amount || 0;
                                        if (session.balances) { session.balances.demo = uD; session.balances.real = uR; }
                                        io.to(uid).emit('balance_sync', { demo: Number(uD).toFixed(2), real: Number(uR).toFixed(2) });
                                    } catch(e){}
                                }
                            }
                        } catch(e){}
                    });
                } catch(e){}

                // Mapeo inicial de activos
                try {
                    const initData = await api.getInitializationData();
                    
                    const exploit = (obj, depth = 0) => {
                        if (!obj || depth > 5) return;
                        if ((obj.active_id || obj.id) && (obj.name || obj.active_name)) {
                            const rawName = (obj.name || obj.active_name || '');
                            const cleanName = rawName.replace('front.', '').replace('binary-', '').replace('-OTC', ' (OTC)').toUpperCase();
                            const activeIdNum = Number(obj.active_id || obj.id);
                            if (activeIdNum > 0 && cleanName) {
                                knownMarkets.set(activeIdNum, cleanName);
                            }
                        }
                        for (const k in obj) if (typeof obj[k] === 'object') exploit(obj[k], depth + 1);
                    };
                    exploit(initData);
                    console.log(`[MAP] Activos totales descubiertos: ${knownMarkets.size}`);
                } catch(e){}

                // Monitor de balance
                const mainLoop = setInterval(() => {
                    socket.emit('balance_sync', { demo: Number(session.balances.demo).toFixed(2), real: Number(session.balances.real).toFixed(2) });
                }, 10000);
                session.mainLoop = mainLoop;

                // --- ESCANER PASIVO DE OPORTUNIDADES CERCANAS (siempre activo, sin operar) ---
                const fetchCandlesPassive = (activeId) => {
                    return new Promise((resolve) => {
                        const timeout = setTimeout(() => resolve(null), 5000);
                        api.getCandles(activeId, 60, 200, Date.now())
                            .then(velas => {
                                clearTimeout(timeout);
                                resolve(velas && velas.length ? velas.sort((a,b) => a.from - b.from) : null);
                            })
                            .catch(() => { clearTimeout(timeout); resolve(null); });
                    });
                };

                const runPassiveScanner = async () => {
                    // Solo correr si el bot principal NO está activo para no duplicar trabajo
                    if (session.botActivo) return;
                    
                    const ACTIVE_IDS = [];
                    knownMarkets.forEach((name, id) => ACTIVE_IDS.push({ id, name }));
                    if (ACTIVE_IDS.length === 0) return;

                    // Escanear los primeros 30 activos para no sobrecargar
                    const sample = ACTIVE_IDS.slice(0, 30);
                    
                    for (const { id, name } of sample) {
                        if (session.botActivo) break; // Si se inicia el bot, parar
                        try {
                            await new Promise(r => setTimeout(r, 200)); // 200ms entre cada activo
                            const velas = await fetchCandlesPassive(id);
                            if (!velas || velas.length < 15) continue;

                            const rsi = calcularRSI(velas, 6);
                            const cci = calcularCCI(velas, 14);
                            const limits = getAssetLimits(name);

                            let near = null;
                            if (rsi <= limits.rsiCall + 15 && cci <= limits.cciCall + 100) near = 'call';
                            if (rsi >= limits.rsiPut  - 15 && cci >= limits.cciPut  - 100) near = 'put';
                            
                            if (near) {
                                const distRsi = near === 'call' ? (limits.rsiCall - rsi).toFixed(1) : (rsi - limits.rsiPut).toFixed(1);
                                socket.emit('near_miss', {
                                    asset: name,
                                    rsi: rsi.toFixed(1),
                                    cci: cci.toFixed(1),
                                    side: near.toUpperCase(),
                                    reason: `[PASIVO] RSI a ${distRsi} pts del umbral`
                                });
                            }
                        } catch(e) {}
                    }
                };

                // Correr el escaner pasivo cada 60 segundos
                session.passiveScanner = setInterval(runPassiveScanner, 60000);
                // Y también al conectar por primera vez (delay de 5s para dar tiempo al mapa)
                setTimeout(runPassiveScanner, 5000);
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
        session.botState = { 
            id: Date.now(), 
            active: true, 
            phase: 'Iniciando...', 
            trades: 0, 
            w: 0, 
            l: 0, 
            account, 
            amount: Number(amount), 
            cycles: Number(cycles), 
            report: [], 
            completedTrades: 0 
        };
        session.botActivo = true; session.scannedAssets = []; session.isLooping = false;
        iniciarMotorBot(socket.uid, session, balanceId, Number(amount));
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 TradeBot PRO v8.5 operativo en puerto ${PORT}`);
});
