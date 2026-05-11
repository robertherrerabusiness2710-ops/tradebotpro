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
        socket.join(uid);
    });

    socket.on('connect_iq', async (data) => {
        const { uid, email, password } = data;
        console.log(`⏳ Conectando IQ para ${email}...`);

        // Limpiar sesión previa para evitar fugas de memoria
        if (userSessions.has(uid)) {
            const prev = userSessions.get(uid);
            if (prev.mainLoop) clearInterval(prev.mainLoop);
            userSessions.delete(uid);
            console.log(`[SESSION] Sesión anterior de ${uid} limpiada.`);
        }

        try {
            const api = new IQOptionApi(email, password);
            const profile = await api.connectAsync();
            
            if (profile) {
                console.log(`✅ Conexión OK: ${profile.name}`);
                userSessions.set(uid, { api, profile });
                
                socket.emit('iq_connected', { name: profile.name });
                
                // Extraer balances iniciales
                let userDemo = profile.balances?.find(b => b.type === 4)?.amount || 0;
                let userReal = profile.balances?.find(b => b.type === 1)?.amount || 0;
                
                socket.emit('balance_sync', {
                    demo: userDemo.toFixed(2),
                    real: userReal.toFixed(2)
                });
                
                // Guardar variables de balance en la sesion para actualizarlas
                userSessions.get(uid).balances = { demo: userDemo, real: userReal };
                
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
                        'otc', 'fr 40', 'ger 30', 'hk 33', 'us 500', 'amazon',
                        'bitcoin', 'btc', 'ethereum', 'eth', 'litecoin', 'ltc', 'ripple', 'xrp',
                        'jupiter', 'tron', 'arbitrum', 'non', 'stellar', 'intel', 'polygon', 'solana'
                    ];

                    // Limpiar lista negra de divisas
                    const FORBIDDEN = ['eur/','gbp/','usd/cad','usd/jpy','aud/','nzd/','chf','eur/gbp'];

                    const tryRegister = (id, name) => {
                        if (!id || !name) return;
                        const n = name.toLowerCase();
                        
                        // Prevención de activos corruptos y divisas estándar no OTC (front.*)
                        if (n.includes('front.') || n.includes('-op') || n.includes('usd')) {
                            // Solo permitir OTC o indices puros
                            if (!n.includes('otc')) return;
                        }
                        
                        const isForbidden = FORBIDDEN.some(f => n.includes(f));
                        if (isForbidden) return;
                        
                        const isTarget = TARGETS.some(t => n.includes(t));
                        if (isTarget && !knownMarkets.has(Number(id))) {
                            knownMarkets.set(Number(id), name);
                            console.log(`[✅ MAPA] Activo Cripto registrado: "${name}" → ID: ${id}`);
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
                            'fr 40', 'ger 30', 'hk 33', 'us 500', 'amazon',
                            'bitcoin', 'btc', 'ethereum', 'eth', 'litecoin', 'ltc', 'ripple', 'xrp',
                            'jupiter', 'tron', 'arbitrum', 'stellar', 'intel', 'polygon', 'solana', 'pepe', 'floki', 'ronin'
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
                    if (liveBotCiclo && liveBotCiclo.stop) liveBotCiclo.stop();
                    liveBotCiclo = null;
                    const { account, cycles } = config;
                    const amount = Number(config.amount); // Aseguramos que sea un número real
                    if (!amount || isNaN(amount)) {
                        return socket.emit('iq_error', { msg: 'Monto de inversión inválido' });
                    }
                    const maxTrades = cycles ? parseInt(cycles) : 10;
                    
                    const balances = profile.balances || [];
                    const typeId = account === 'real' ? 1 : 4;
                    const balanceSelect = balances.find(b => b.type === typeId);
                    const balanceId = balanceSelect ? balanceSelect.id : profile.balance_id;

                    let tradesRealizados = 0;
                    let wins = 0; let losses = 0;
                    const tradeLocks = new Map(); 
                    const currentCycleTrades = [];
                    
                    // ESCÁNER: solo IDs que tenemos registrados
                    const ACTIVOS_A_ESCANEAR = [];
                    knownMarkets.forEach((name, id) => ACTIVOS_A_ESCANEAR.push(id));

                    // 🛡️ SISTEMA DE RESPALDO (FALLBACK)
                    // Si el broker no envió la lista de activos a tiempo, forzamos los IDs principales de cripto
                    if (ACTIVOS_A_ESCANEAR.length === 0) {
                        console.log(`[BOT WARNING] Usando mapa de criptos de respaldo...`);
                        const fallbackActivos = [
                            { id: 816, name: 'Bitcoin (OTC)' },
                            { id: 817, name: 'Ethereum (OTC)' },
                            { id: 1072, name: 'Ripple (OTC)' },
                            { id: 1073, name: 'Solana (OTC)' },
                            { id: 100000, name: 'US 500' }, // ID ficticio para indices, solo para fallback
                            { id: 100001, name: 'Amazon' },
                            { id: 100002, name: 'FR 40' }
                        ];
                        fallbackActivos.forEach(act => {
                            knownMarkets.set(act.id, act.name);
                            ACTIVOS_A_ESCANEAR.push(act.id);
                        });
                    }

                    socket.emit('live_bot_update', { phase: `🔍 Activos listos: ${ACTIVOS_A_ESCANEAR.length} | Iniciando escaneo RSI+CCI...`, trades: 0, w: 0, l: 0 });

                    console.log(`[BOT] Iniciando. Activos a escanear (${ACTIVOS_A_ESCANEAR.length}):`, 
                        ACTIVOS_A_ESCANEAR.map(id => `${id}=${knownMarkets.get(id)||'?'}`).join(', '));

                    liveBotCiclo = true;
                    let botActivo = true;

                    // Emitir lista inicial al frontend para mostrar todas las barras
                    const assetList = [];
                    knownMarkets.forEach((name) => assetList.push({ asset: name, rsi: 50, cci: 0 }));
                    socket.emit('scan_init', { assets: assetList });
                    socket.emit('scan_telemetry', { results: assetList });

                    // ── CONTADOR GLOBAL PARA request_id ÚNICOS Y SIMPLES ──
                    let _reqCounter = 10;
                    const nextReqId = () => ++_reqCounter;

                    // ── FETCH DE VELAS VÍA WEBSOCKET DIRECTO (sin cola) ──
                    // BUG ORIGINAL CORREGIDO: IQ Option devuelve request_id como número,
                    // la comparación request_id === reqId fallaba (string !== number)
                    const fetchCandlesWS = (activeId) => {
                        return new Promise((resolve) => {
                            const reqId = nextReqId();
                            let done = false;

                            const cleanup = () => {
                                clearTimeout(timer);
                                api.iqOptionWs.socket().off('message', handler);
                            };

                            const handler = (rawMsg) => {
                                try {
                                    const js = JSON.parse(rawMsg.toString());
                                    // Comparar como strings para evitar number vs string mismatch
                                    const idMatch = String(js.request_id) === String(reqId);
                                    const nameOk  = !js.name || js.name === 'candles' ||
                                                    js.name === 'get-candles' || js.name === 'get-candles-v2';
                                    if (idMatch && nameOk && js.msg && !done) {
                                        let candles = Array.isArray(js.msg) ? js.msg
                                            : (js.msg.candles || js.msg.data || js.msg.result || []);
                                            
                                        // ASEGURAR ORDEN CRONOLÓGICO: 0 = más antigua, length-1 = actual/nueva
                                        candles = candles.sort((a, b) => {
                                            const tsA = a.from || a.id || a.at || 0;
                                            const tsB = b.from || b.id || b.at || 0;
                                            return tsA - tsB;
                                        });
                                            
                                        done = true;
                                        cleanup();
                                        resolve(candles);
                                    }
                                } catch { /* empty */ }
                            };

                            api.iqOptionWs.socket().on('message', handler);

                            const timer = setTimeout(() => {
                                if (!done) { done = true; cleanup(); resolve([]); }
                            }, 4000); // 4s timeout por activo

                            // Formato correcto V2 de IQ Option (to + count, NO from_id/to_id)
                            api.iqOptionWs.send('sendMessage', {
                                name: 'get-candles',
                                version: '2.0',
                                body: {
                                    active_id: activeId,
                                    size: 60,
                                    to: Math.floor(Date.now() / 1000),
                                    count: 200 // Incrementado a 200 para el suavizado preciso de Wilder RSI
                                }
                            }, reqId);
                        });
                    };

                    // Función recursiva de escaneo
                    const ejecutarCiclo = async () => {
                        if (!botActivo) return;

                        if (tradesRealizados >= maxTrades) {
                            botActivo = false;
                            socket.emit('live_bot_finished', { 
                                trades: tradesRealizados, 
                                w: wins, 
                                l: losses,
                                report: currentCycleTrades
                            });
                            return;
                        }

                        let scanResults = [];
                        const totalActivos = ACTIVOS_A_ESCANEAR.length;
                        
                        for (let idx = 0; idx < ACTIVOS_A_ESCANEAR.length; idx++) {
                            if (!botActivo || tradesRealizados >= maxTrades) break;
                            
                            const currentAsset = ACTIVOS_A_ESCANEAR[idx];
                            const assetName = knownMarkets.get(currentAsset) || `ID:${currentAsset}`;

                            // Saltar activos que fallan repetidamente
                            const failCount = deadAssets.get(currentAsset) || 0;
                            if (failCount >= 3) continue;
                            
                            socket.emit('live_bot_update', { 
                                phase: `🔍 [${idx+1}/${totalActivos}] ${assetName}...`, 
                                trades: tradesRealizados, w: wins, l: losses 
                            });

                            try {
                                // Obtener velas vía WebSocket directo (SIN COLA)
                                const velasOTC = await fetchCandlesWS(currentAsset);

                                if (!velasOTC || velasOTC.length < 15) {
                                    const nf = (deadAssets.get(currentAsset) || 0) + 1;
                                    deadAssets.set(currentAsset, nf);
                                    console.log(`[SKIP] ${assetName}: ${velasOTC?.length || 0} velas (fallo #${nf})`);
                                    continue;
                                }

                                deadAssets.set(currentAsset, 0); // Éxito - reset contador

                                const rsi = calcularRSI(velasOTC, 6);
                                const cci = calcularCCI(velasOTC, 14);

                                console.log(`[📊] ${assetName} RSI:${rsi.toFixed(1)} CCI:${cci.toFixed(1)}`);
                                
                                scanResults.push({ asset: assetName, rsi, cci });
                                socket.emit('scan_telemetry', { results: [...scanResults] });

                                let direccion = null;
                                // ESTRATEGIA RSI+CCI (ambos confirman según Interfaz Visual del usuario)
                                if (rsi <= 10.0 && cci <= -200.0) direccion = 'call'; // COMPRA
                                if (rsi >= 90.0 && cci >= 200.0)  direccion = 'put';  // VENTA

                                if (direccion && !esLateralizado(velasOTC)) {
                                    console.log(`[🚫 TENDENCIA] ${assetName} está en tendencia fuerte. Ignorando para buscar mercado lateralizado.`);
                                    direccion = null;
                                }

                                if (direccion) {
                                    const currentSeconds = new Date().getSeconds();
                                    if (currentSeconds < 58) {
                                        const waitTime = (58 - currentSeconds) * 1000;
                                        console.log(`[ESPERA] ${assetName} en pre-señal. Esperando ${waitTime}ms al cierre de vela...`);
                                        socket.emit('live_bot_update', { 
                                            phase: `⏳ Esperando cierre vela ${assetName}...`, 
                                            trades: tradesRealizados, w: wins, l: losses 
                                        });
                                        await new Promise(r => setTimeout(r, waitTime));
                                        
                                        // RE-VERIFICAR CONDICIONES JUSTO ANTES DE CERRAR
                                        try {
                                            let velasConf = await api.getCandles(currentAsset, 60, 200, Date.now()); // 200 para suavizado Wilder
                                            velasConf = velasConf.sort((a, b) => (a.from || a.id || 0) - (b.from || b.id || 0));
                                            
                                            const rsiConf = calcularRSI(velasConf, 6);
                                            const cciConf = calcularCCI(velasConf, 14);
                                            
                                            let dirConf = null;
                                            if (rsiConf <= 10.0 && cciConf <= -200.0) dirConf = 'call';
                                            if (rsiConf >= 90.0 && cciConf >= 200.0)  dirConf = 'put';
                                            
                                            if (!dirConf) {
                                                console.log(`[CANCELADO] ${assetName} no cumplió condición al cierre (RSI:${rsiConf.toFixed(1)} CCI:${cciConf.toFixed(1)})`);
                                                continue;
                                            }
                                            direccion = dirConf;
                                            
                                            // Esperar hasta el segundo 00 de la nueva vela
                                            const finalWait = (60 - new Date().getSeconds()) * 1000;
                                            if (finalWait > 0) await new Promise(r => setTimeout(r, finalWait));
                                            
                                        } catch(e) {
                                            console.log(`[ERR RE-CHECK] ${assetName}`);
                                            continue;
                                        }
                                    }

                                    const ultimaVela  = velasOTC[velasOTC.length - 1];
                                    const velaTs  = ultimaVela.from || ultimaVela.id || ultimaVela.at || Date.now();
                                    const lockId  = `${currentAsset}_${velaTs}`;
                                    const cooldown = tradeLocks.get(`${currentAsset}_cd`) || 0;
                                    
                                    if (tradeLocks.has(lockId) || Date.now() < cooldown) {
                                        console.log(`[LOCK] ${assetName}: Vela ya usada.`);
                                        continue;
                                    }

                                    const side = direccion;
                                    console.log(`[🎯] DISPARO ${side.toUpperCase()} → ${assetName} RSI:${rsi.toFixed(1)} CCI:${cci.toFixed(1)}`);
                                    socket.emit('live_bot_update', { 
                                        phase: `🎯 ${side.toUpperCase()} → ${assetName}`, 
                                        trades: tradesRealizados, w: wins, l: losses 
                                    });
                                    tradeLocks.set(lockId, true);

                                    try {
                                        const order = await api.sendOrderBinary(
                                            currentAsset, side, iqOptionExpired(1), balanceId, 0, amount
                                        );
                                        
                                        // Extraer el precio REAL de mercado al inicio de la vela
                                        let entryPrice = ultimaVela.close;
                                        try {
                                            const postVelas = await api.getCandles(currentAsset, 60, 1, Date.now());
                                            if (postVelas && postVelas.length > 0) {
                                                entryPrice = postVelas[postVelas.length - 1].open;
                                            }
                                        } catch (e) { /* fallback a ultimaVela.close */ }
                                        
                                        const tradeStatus = {
                                            id: Date.now(),
                                            asset: assetName,
                                            side: side.toUpperCase(),
                                            entry: entryPrice,
                                            rsi: rsi.toFixed(1),
                                            cci: cci.toFixed(1),
                                            time: new Date().toLocaleTimeString(),
                                            result: 'PROCESANDO...',
                                            color: 'text-blue-400'
                                        };
                                        
                                        socket.emit('trade_executed', tradeStatus);
                                        currentCycleTrades.push(tradeStatus);
                                        tradesRealizados++;
                                        console.log(`[✅ ORDEN OK] ${assetName} ${side.toUpperCase()} entrada:${tradeStatus.entry}`);

                                        setTimeout(async () => {
                                            try {
                                                let velasCierre = await api.getCandles(currentAsset, 60, 4, Date.now());
                                                velasCierre = velasCierre.sort((a, b) => (a.from || a.id || 0) - (b.from || b.id || 0));
                                                
                                                // La vela en curso es length-1. La vela que acaba de cerrar (donde operamos) es length-2.
                                                const finalPrice = velasCierre[velasCierre.length - 2].close;
                                                
                                                let isLoss = true;
                                                if (side === 'call' && finalPrice > entryPrice) isLoss = false;
                                                if (side === 'put' && finalPrice < entryPrice) isLoss = false;
                                                // Si es empate, lo tomamos como pérdida en binarias usualmente, o podemos omitir.
                                                
                                                tradeStatus.result = isLoss ? 'PERDIDA' : 'GANADA';
                                                tradeStatus.color = isLoss ? 'text-red-400' : 'text-green-400';
                                                tradeStatus.winner = !isLoss;
                                                
                                                // Actualizar balance simulado local y emitirlo
                                                const sess = userSessions.get(uid);
                                                if (sess && sess.balances) {
                                                    const bal = sess.balances;
                                                    if (isLoss) {
                                                        if (account === 'demo') bal.demo -= amount;
                                                        else bal.real -= amount;
                                                    } else {
                                                        const profit = amount * 0.85; // Aprox ganancia binaria
                                                        if (account === 'demo') bal.demo += profit;
                                                        else bal.real += profit;
                                                    }
                                                    socket.emit('balance_sync', { demo: bal.demo.toFixed(2), real: bal.real.toFixed(2) });
                                                }

                                                if (isLoss) {
                                                    losses++;
                                                    tradeLocks.set(`${currentAsset}_cd`, Date.now() + 180000);
                                                } else { wins++; }
                                                socket.emit('live_trade_result', tradeStatus);
                                            } catch (errCierre) {
                                                console.log(`[VERIFICACION FALLIDA] ${assetName}: no se pudo obtener precio de cierre.`);
                                                // Fallback si falla getCandles
                                                tradeStatus.result = 'ERROR VERIF';
                                                tradeStatus.color = 'text-yellow-400';
                                                socket.emit('live_trade_result', tradeStatus);
                                            }
                                        }, 65000);

                                    } catch(errOrder) {
                                        const em = (errOrder?.message || String(errOrder)).replace(/%!s\(MISSING\)/g,'');
                                        if (!em.includes('suspend') && !em.includes('not possible')) {
                                            socket.emit('iq_error', { msg: `${assetName}: ${em}` });
                                        }
                                        console.log(`[ORDEN FAIL] ${assetName}: ${em}`);
                                    }
                                }
                            } catch(e) {
                                console.log(`[ERR] ${assetName}: ${e?.message}`);
                            }
                            
                            await new Promise(r => setTimeout(r, 200)); // Pausa mínima entre activos
                        }
                        
                        console.log(`[CICLO ✅] G:${wins} P:${losses} Disparadas:${tradesRealizados}/${maxTrades}`);
                        
                        if (botActivo && tradesRealizados < maxTrades) {
                            socket.emit('live_bot_update', { 
                                phase: `⏳ Recargando en 8s... (${tradesRealizados}/${maxTrades})`,
                                trades: tradesRealizados, w: wins, l: losses 
                            });
                            setTimeout(ejecutarCiclo, 8000);
                        } else if (botActivo && tradesRealizados >= maxTrades) {
                            socket.emit('live_bot_update', { 
                                phase: `⏳ Esperando cierre de operaciones... (${tradesRealizados}/${maxTrades})`,
                                trades: tradesRealizados, w: wins, l: losses 
                            });
                            
                            // Esperar a que el setTimeout de 65s de las operaciones termine
                            // Chequeamos cada 5s si (wins + losses) == tradesRealizados
                            const checkFinish = setInterval(() => {
                                if (wins + losses >= tradesRealizados || !botActivo) {
                                    clearInterval(checkFinish);
                                    if (botActivo) {
                                        botActivo = false;
                                        socket.emit('live_bot_finished', { 
                                            trades: tradesRealizados, 
                                            w: wins, 
                                            l: losses,
                                            report: currentCycleTrades
                                        });
                                    }
                                }
                            }, 5000);
                        }
                    };

                    liveBotCiclo = { stop: () => { botActivo = false; } };
                    ejecutarCiclo(); // Arranca inmediatamente





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
                                       socket.emit('price_multi_update', { prices: priceList });
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
                userSessions.set(uid, { api, profile, mainLoop });
                getRealPrices(); // Carga inicial

                socket.on('disconnect', () => {
                    const session = userSessions.get(uid);
                    if (session && session.mainLoop) clearInterval(session.mainLoop);
                    userSessions.delete(uid);
                    console.log(`[SESSION] Sesión ${uid} cerrada limpiamente.`);
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
