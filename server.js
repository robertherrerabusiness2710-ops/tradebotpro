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

io.on('connection', (socket) => {
    console.log('🔌 Cliente Conectado:', socket.id);

    socket.on('auth_link', (uid) => {
        console.log(`[AUTH] Solicitud de reconexión para UID: ${uid}`);
        socket.join(uid);
        socket.uid = uid;
        const session = userSessions.get(uid);
        if (session && session.profile) {
            socket.emit('iq_connected', { name: session.profile.name });
            if (session.balances) {
                socket.emit('balance_sync', {
                    demo: Number(session.balances.demo).toFixed(2),
                    real: Number(session.balances.real).toFixed(2)
                });
            }
            if (session.botActivo && session.botState) {
                // Restaurar radar inmediatamente
                if (session.scannedAssets && session.scannedAssets.length > 0) {
                    socket.emit('scan_init', { assets: session.scannedAssets });
                    socket.emit('scan_telemetry', { results: session.scannedAssets });
                }
                socket.emit('bot_restored_state', { ...session.botState, phase: session.botState.phase });
                
                // ASEGURAR QUE EL MOTOR ESTÉ CORRIENDO
                if (!session.isLooping) {
                    console.log(`[RECOVERY] Reiniciando motor para ${uid}`);
                    iniciarMotorBot(uid, session);
                }
            }
        }
    });

    socket.on('connect_iq', async (data) => {
        const { uid, email, password } = data;
        console.log(`⏳ Conectando IQ para ${email}...`);

        // Eliminar limpieza agresiva. La sesión perdurará aunque se refresque.

        try {
            const api = new IQOptionApi(email, password);
            const profile = await api.connectAsync();
            
            if (profile) {
                console.log(`✅ Conexión OK: ${profile.name}`);
                userSessions.set(uid, { api, profile });
                
                socket.emit('iq_connected', { name: profile.name });
                
                // Extraer balances iniciales correctamente
                let userDemo = profile.balances?.find(b => b.type === 4)?.amount || profile.balances?.find(b => b.type === 4)?.balance || 0;
                let userReal = profile.balances?.find(b => b.type === 1)?.amount || profile.balances?.find(b => b.type === 1)?.balance || 0;
                
                socket.emit('balance_sync', {
                    demo: Number(userDemo).toFixed(2),
                    real: Number(userReal).toFixed(2)
                });
                
                // Guardar variables de balance en la sesion para actualizarlas
                userSessions.set(uid, { api, profile, balances: { demo: Number(userDemo), real: Number(userReal) } });
                
                // DIAGNÓSTICO PROFUNDO: Guardar el perfil en archivo físico
                try {
                    fs.writeFileSync(path.join(__dirname, 'profile_debug.json'), JSON.stringify(profile, null, 2));
                    console.log('Balance guardado para uso Offline.');
                } catch (err) {
                    console.error('Error guardando diagnóstico:', err);
                }

                // NUEVO: SISTEMA DE MAPEADO DE ACTIVOS (Versiones Corregidas)
                try {
                    api.iqOptionWs.send('sendMessage', {
                        name: 'get-instruments', version: '4.0', body: { type: 'crypto' }
                    }, Date.now() + 1);
                    api.iqOptionWs.send('sendMessage', {
                        name: 'get-instruments', version: '4.0', body: { type: 'cfd' }
                    }, Date.now() + 2);
                    api.iqOptionWs.send('sendMessage', {
                        name: 'get-instruments', version: '4.0', body: { type: 'forex' }
                    }, Date.now() + 3);
                    api.iqOptionWs.send('sendMessage', {
                        name: 'get-instruments', version: '3.0', body: { type: 'binary' }
                    }, Date.now() + 4);
                    api.iqOptionWs.send('sendMessage', {
                        name: 'digital-option-instruments.get-instruments', version: '1.0', body: { routingFilters: { instrument_type: 'digital-option' } }
                    }, Date.now() + 5);
                } catch {
                    // fallBack silencio
                }

                const calcularRSI = (velas, periodos = 6) => {
                    if (velas.length < periodos + 1) return 50;
                    let gains = 0, losses = 0;
                    
                    // 1. Promedio simple inicial
                    for (let i = 1; i <= periodos; i++) {
                        const diff = velas[i].close - velas[i - 1].close;
                        if (diff > 0) gains += diff;
                        else losses -= diff;
                    }
                    gains /= periodos;
                    losses /= periodos;
                    
                    // 2. Suavizado de Wilder (Exponential Moving Average)
                    for (let i = periodos + 1; i < velas.length; i++) {
                        const diff = velas[i].close - velas[i - 1].close;
                        let currentGain = 0, currentLoss = 0;
                        if (diff > 0) currentGain = diff;
                        else currentLoss = -diff;
                        
                        gains = (gains * (periodos - 1) + currentGain) / periodos;
                        losses = (losses * (periodos - 1) + currentLoss) / periodos;
                    }
                    
                    if (losses === 0) return 100;
                    const rs = gains / losses;
                    return 100 - (100 / (1 + rs));
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
                    // 1. Evitar "Velas Pegadas" (Tendencia prolongada donde RSI se queda en extremo)
                    const rsiAnt1 = calcularRSI(velas.slice(0, -1), 6);
                    const rsiAnt2 = calcularRSI(velas.slice(0, -2), 6);
                    const rsiAct = calcularRSI(velas, 6);
                    
                    if (rsiAct >= 90 && rsiAnt1 >= 90 && rsiAnt2 >= 90) return false; // Fuerte alza prolongada
                    if (rsiAct <= 10 && rsiAnt1 <= 10 && rsiAnt2 <= 10) return false; // Fuerte baja prolongada

                    // 2. Revisar la acción de precio (últimas 4 velas)
                    const ultimas4 = velas.slice(-4);
                    let verdes = 0; let rojas = 0;
                    ultimas4.forEach(v => {
                        if (v.close > v.open) verdes++;
                        else rojas++;
                    });
                    if (verdes >= 4 || rojas >= 4) return false; // 4 velas seguidas en 1 dirección = tendencia

                    return true;
                };

                const iqOptionExpired = (minutes) => {
                    let d = new Date();
                    if (d.getSeconds() > 30) minutes += 1;
                    d.setMinutes(d.getMinutes() + minutes);
                    d.setSeconds(0);
                    d.setMilliseconds(0);
                    return Math.floor(d.getTime() / 1000);
                };

                // MOTOR LIVE DE OPERATORIA
                let liveBotCiclo = null; 
                const deadAssets = new Map(); // Cache de activos que no responden

                // IDs VERIFICADOS de Índices OTC (funcionan con getCandles)
                // Los cripto OTC se descubren dinámicamente desde IQ Option
                const knownMarkets = new Map();

                // ── DESCUBRIMIENTO REAL DE IDs CRIPTO DESDE IQ OPTION ──
                console.log('[MAP] Consultando catálogo real de IQ Option...');
                try {
                    const initData = await api.getInitializationData();
                    
                    // Guardar respuesta RAW para diagnóstico
                    const rawPath = path.join(__dirname, 'iq_init_data.json');
                    fs.writeFileSync(rawPath, JSON.stringify(initData, null, 2));
                    console.log(`[MAP] Datos crudos guardados en ${rawPath}`);

                    const TARGETS = [
                        'fr 40', 'ger 30', 'hk 33', 'us 500', 'us30', 'jp225', 'amazon',
                        'bitcoin', 'btc', 'ethereum', 'eth', 'litecoin', 'ltc', 'ripple', 'xrp',
                        'jupiter', 'tron', 'arbitrum', 'stellar', 'intel', 'polygon', 'solana', 'pepe', 'floki', 'ronin', 'non'
                    ];

                    // Limpiar lista negra de divisas
                    const FORBIDDEN = ['eur/','gbp/','usd/cad','usd/jpy','aud/','nzd/','chf','eur/gbp'];

                    const tryRegister = (id, name) => {
                        if (!id || !name) return;
                        let n = name.toLowerCase();
                        
                        if (n.includes('front.') || n.includes('-op') || n.includes('usd')) {
                            if (!n.includes('otc')) return;
                        }
                        
                        const isForbidden = FORBIDDEN.some(f => n.includes(f));
                        if (isForbidden) return;
                        
                        const isTarget = TARGETS.some(t => n.includes(t));
                        if (isTarget && !knownMarkets.has(Number(id))) {
                            let cleanName = name.replace('front.', '').replace('binary-', '').replace('-OTC', ' (OTC)').toUpperCase();
                            knownMarkets.set(Number(id), cleanName);
                            console.log(`[✅ MAPA] Activo registrado: "${cleanName}" → ID: ${id}`);
                        }
                    };

                    // Buscar en TODOS los campos posibles de initData
                    const exploit = (obj, depth = 0) => {
                        if (!obj || depth > 5) return;
                        if (typeof obj !== 'object') return;
                        // Si el objeto tiene id y name, es un activo
                        if ((obj.active_id || obj.id) && (obj.name || obj.active_name)) {
                            tryRegister(obj.active_id || obj.id, obj.name || obj.active_name);
                        }
                        // Continuar búsqueda en profundidad
                        for (const key of Object.keys(obj)) {
                            const child = obj[key];
                            if (child && typeof child === 'object') {
                                exploit(child, depth + 1);
                            }
                        }
                    };
                    exploit(initData);

                    console.log(`[MAP] Total activos en mapa tras búsqueda: ${knownMarkets.size}`);
                    knownMarkets.forEach((name, id) => console.log(`  → ID ${id}: ${name}`));

                } catch(errInit) {
                    console.log('[MAP] getInitializationData falló:', errInit.message);
                }

                // ESCUCHA EN VIVO: Captura IDs de activos que IQ Option menciona en el WebSocket
                api.iqOptionWs.socket().on('message', (message) => {
                    try {
                        const js = JSON.parse(message.toString());
                        const TARGETS_VIVOS = [
                            'fr 40', 'ger 30', 'hk 33', 'us 500', 'us30', 'jp225', 'amazon',
                            'bitcoin', 'btc', 'ethereum', 'eth', 'litecoin', 'ltc', 'ripple', 'xrp',
                            'jupiter', 'tron', 'arbitrum', 'stellar', 'intel', 'polygon', 'solana', 'pepe', 'floki', 'ronin', 'non'
                        ];
                        const FORBIDDEN_VIVOS = ['eur','gbp','cad','jpy','aud','nzd','chf','shib','front.','-op'];

                        const insts = js.msg?.instruments || js.msg?.data ||
                            (Array.isArray(js.msg) ? js.msg : null);
                        if (!insts) return;
                        insts.forEach(inst => {
                            const n = (inst.name || inst.active_name || '').toLowerCase();
                            const id = inst.active_id || inst.id;
                            if (!n || !id) return;
                            
                            if (FORBIDDEN_VIVOS.some(f => n.includes(f))) return;
                            
                            if (TARGETS_VIVOS.some(t => n.includes(t)) && !knownMarkets.has(Number(id))) {
                                knownMarkets.set(Number(id), inst.name || inst.active_name);
                                console.log(`[MAP LIVE ✓] ${inst.name} → ID: ${id}`);
                            }
                        });
                    } catch { /* empty */ }
                });

                socket.on('start_live_bot', async (config) => {
                    const session = userSessions.get(uid);
                    if (!session) return;
                    
                    if (session.botActivo) {
                        session.botActivo = false;
                        if (session.botTimeout) clearTimeout(session.botTimeout);
                    }

                    const { account, cycles } = config;
                    const amount = Number(config.amount) || 10;
                    const api = session.api;
                    const profile = session.profile;

                    const balances = profile.balances || [];
                    const typeId = account === 'real' ? 1 : 4;
                    const balanceSelect = balances.find(b => b.type === typeId);
                    const balanceId = balanceSelect ? balanceSelect.id : profile.balance_id;

                    session.botState = { 
                        active: true, phase: 'Iniciando escaneo...', 
                        trades: 0, w: 0, l: 0, account, amount, cycles, report: [] 
                    };
                    session.botActivo = true;
                    session.scannedAssets = [];
                    session.isLooping = false;

                    iniciarMotorBot(uid, session, balanceId, amount);
                });

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
                                        clearTimeout(t);
                                        api.iqOptionWs.removeListener('message', h);
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
                            session.botActivo = false;
                            session.isLooping = false;
                            io.to(uid).emit('live_bot_finished', { trades: s.trades, w: s.w, l: s.l, report: s.report });
                            return;
                        }

                        const ACTIVOS = [];
                        knownMarkets.forEach((name, id) => ACTIVOS.push(id));
                        if (ACTIVOS.length === 0) { // Emergency fallback
                            [816, 817, 1072, 1073, 1074, 994, 993, 1000, 1001, 1002, 1003, 1004, 1005, 76, 77, 78, 81].forEach(id => ACTIVOS.push(id));
                        }

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
                                
                                // SR Lógica
                                const last20 = velas.slice(-20);
                                const maxH = Math.max(...last20.map(v => v.max || v.high || v.close));
                                const minL = Math.min(...last20.map(v => v.min || v.low || v.close));
                                const currP = velas[velas.length-1].close;
                                const h = maxH - minL;
                                const atR = h === 0 || currP >= maxH - (h * 0.15);
                                const atS = h === 0 || currP <= minL + (h * 0.15);

                                // Telemetría
                                const rScore = rsi >= 90 || rsi <= 10 ? 100 : Math.min(100, (Math.abs(rsi-50)/40)*100);
                                const cScore = Math.abs(cci) >= 200 ? 100 : Math.min(100, (Math.abs(cci)/200)*100);
                                const prog = ((rScore + cScore)/2).toFixed(0);
                                updateScannedAssets(name, rsi.toFixed(1), cci.toFixed(1), prog);
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
                                        const order = await api.sendOrderBinary(id, dir, iqOptionExpired(1), balanceId, 0, amount);
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
                        } else {
                            session.isLooping = false;
                        }
                    };
                    loop();
                }





                });

                // SINCRONIZADOR DE SALDO MEJORADO
                const syncData = () => {
                    const balances = profile.balances || [];
                    
                    // 1 = Real (FIAT), 4 = Demo (TEST), 5 = CRYPTO
                    const realBal = balances.find(b => b.type === 1);
                    const demoBal = balances.find(b => b.type === 4);

                    const realAmount = realBal ? (realBal.amount !== undefined ? realBal.amount : (realBal.balance || 0)) : (profile.balance_type === 1 ? profile.balance : 0);
                    const demoAmount = demoBal ? (demoBal.amount !== undefined ? demoBal.amount : (demoBal.balance || 10000)) : (profile.balance_type === 4 ? profile.balance : 10000);

                    console.log(`💰 Real Calculado: $${realAmount} | Demo Calculado: $${demoAmount}`);

                    socket.emit('balance_sync', { 
                        real: Number(realAmount).toFixed(2), 
                        demo: Number(demoAmount).toFixed(2) 
                    });
                };
                
                syncData(); // Envío inmediato

                // MONITOR DE PRECIOS REALES (Nivel TradingView via Binance API)
                const getRealPrices = () => {
                   if (!userSessions.has(uid)) return;

                   const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
                   const priceList = [];
                   
                   symbols.forEach(symbol => {
                       const req = https.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, (res) => {
                           let data = '';
                           res.on('data', (chunk) => data += chunk);
                           res.on('end', () => {
                               try {
                                   const json = JSON.parse(data);
                                   priceList.push({
                                       pair: symbol.replace('USDT', ''),
                                       price: parseFloat(json.price).toLocaleString('en-US', { minimumFractionDigits: 2 }),
                                       timestamp: new Date().toLocaleTimeString()
                                   });
                                   if (priceList.length === symbols.length) {
                                       io.to(uid).emit('price_multi_update', { prices: priceList });
                                   }
                               } catch { /* empty */ }
                           });
                       }).on('error', () => {});
                       // Timeout de 8 segundos para evitar peticiones colgadas
                       req.setTimeout(8000, () => {
                           req.destroy();
                           console.log(`[BINANCE TIMEOUT] ${symbol}`);
                       });
                   });
                   syncData();
                };
                
                const mainLoop = setInterval(getRealPrices, 5000);
                if (userSessions.has(uid)) {
                    const existing = userSessions.get(uid);
                    if (existing.mainLoop) clearInterval(existing.mainLoop);
                    // Preservar balances si ya existen
                    const currentBalances = existing.balances || {demo: 0, real: 0};
                    userSessions.set(uid, { ...existing, api, profile, mainLoop, balances: currentBalances });
                } else {
                    userSessions.set(uid, { api, profile, mainLoop, balances: {demo: 0, real: 0} });
                }
                getRealPrices(); // Carga inicial

                socket.on('disconnect', () => {
                    // No borramos la sesión en disconnect, permitimos la reconexión al recargar la página.
                    console.log(`[SESSION] Socket desconectado. Sesión ${uid} en standby.`);
                });
            }
        } catch (err) {
            console.log('❌ Error IQ:', err.message);
            // Limpiar errores crípticos de la librería para Robert
            const cleanMsg = err.message.replace(/%!s\(MISSING\)/g, "Activo no soportado en esta cuenta");
            socket.emit('iq_error', { msg: cleanMsg });
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(50));
    console.log(`🚀 [ESTADO: OPERATIVO] TradeBot PRO v8.5`);
    console.log(`📡 PUERTO: ${PORT}`);
    console.log(`🌐 ACCESO: http://localhost:${PORT}`);
    console.log('='.repeat(50));
    console.log('✅ EL MOTOR ESTÁ LISTO PARA RECIBIR VINCULACIÓN...');
    console.log('🔇 Filtro Anti-Ruido de IQ Option Activado.');

    // Solo silenciar el ruido conocido de la librería, no errores reales
    const originalConsoleError = console.error;
    console.error = (msg, ...rest) => {
        if (typeof msg === 'string' && (msg.includes('getCandles') || msg.includes('winston'))) return;
        originalConsoleError(msg, ...rest);
    };
});
