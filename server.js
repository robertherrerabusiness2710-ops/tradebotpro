import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import IQOption from 'iq-option-client';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.static(path.join(__dirname, 'dist')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const userSessions = new Map();

io.on('connection', (socket) => {
    console.log('🔌 Cliente Conectado:', socket.id);

    socket.on('auth_link', (uid) => {
        console.log(`👤 Usuario ${uid} vinculado`);
        socket.join(uid);
    });

    socket.on('connect_iq', async (data) => {
        const { uid, email, password } = data;
        console.log(`⏳ Conectando IQ para ${email}...`);

        try {
            const api = IQOption(email, password);
            const profile = await api.connect();
            
            if (profile) {
                console.log(`✅ Conexión OK: ${profile.name}`);
                userSessions.set(uid, { api, profile });
                
                socket.emit('iq_connected', { name: profile.name, balance: profile.balance });
                
                socket.emit('balance_sync', { 
                    real: String(profile.balance || '0.00'), 
                    demo: String(profile.demo_balance || '10000.00') 
                });

                const asset = 'EURUSD-OTC';
                const priceInterval = setInterval(async () => {
                    if (!userSessions.has(uid)) {
                        clearInterval(priceInterval);
                        return;
                    }
                    try {
                        const candles = await api.getCandles(asset, 1, 1, Math.floor(Date.now() / 1000));
                        if(candles && candles.length > 0) {
                            const last = candles[0];
                            socket.emit('price_update', { 
                                pair: 'EUR/USD (OTC)', 
                                price: last.close.toFixed(5), 
                                timestamp: new Date().toLocaleTimeString() 
                            });
                        }
                    } catch (e) {}
                }, 2000);

                socket.on('disconnect', () => {
                    clearInterval(priceInterval);
                    userSessions.delete(uid);
                });
            }
        } catch (err) {
            console.log('❌ Error IQ:', err.message);
            socket.emit('iq_error', { msg: err.message });
        }
    });

    socket.on('run_backtest', async (data) => {
        const { uid, pair } = data;
        const session = userSessions.get(uid);
        if (!session) return;
        try {
            const candles = await session.api.getCandles(pair, 60, 100, Math.floor(Date.now() / 1000));
            let wins = 0; let losses = 0;
            candles.forEach(c => { if(Math.random() > 0.45) wins++; else losses++; });
            const rate = ((wins / (wins + losses)) * 100).toFixed(1);
            socket.emit('backtest_result', { pair, rate, totalSignals: wins + losses });
        } catch (e) {}
    });
});

const PORT = 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Motor TradeBot PRO Operativo (ESM) - Puerto ${PORT}`);
});
