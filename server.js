import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'iq-option-client';
const { IQOptionApi } = pkg;

dotenv.config();

const app = express();
app.use(cors({ origin: "*" })); 

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

const userSessions = new Map(); 

// --- CALCULOS MATEMÁTICOS DE TRADING (ESTRATEGIA ROBERT HERRERA) ---

function calculateRSI(closes, period = 6) {
    if (closes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - (100 / (1 + rs));
}

function calculateCCI(candles, period = 14) {
    if (candles.length < period) return 0;
    const tps = candles.slice(-period).map(c => (c.max + c.min + c.close) / 3);
    const sma = tps.reduce((a, b) => a + b, 0) / period;
    const meanDev = tps.map(tp => Math.abs(tp - sma)).reduce((a, b) => a + b, 0) / period;
    if (meanDev === 0) return 0;
    return (tps[tps.length - 1] - sma) / (0.015 * meanDev);
}

// ------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log(`🔌 Cliente Conectado: ${socket.id}`);

  socket.on('auth_link', (uid) => {
    socket.join(uid);
    console.log(`👤 Usuario ${uid} vinculado`);
  });

  socket.on('connect_iq', async (creds) => {
    const { uid, email, password } = creds;
    console.log(`⏳ Conectando IQ para ${email}...`);
    
    try {
      const api = new IQOptionApi(email, password);
      // Timeout 30s
      const connectPromise = api.connectAsync();
      const timeoutPromise = new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 30000));
      const profile = await Promise.race([connectPromise, timeoutPromise]);
      
      userSessions.set(uid, { api, email });
      io.to(uid).emit('iq_connected', { name: profile.name, email });
      console.log(`✅ Conexión OK: ${profile.name}`);

      // Suscribirse a cotización en vivo (EURUSD-OTC por defecto)
      const defaultPair = 'EURUSD-OTC';
      await api.subscribeCandles(defaultPair, 1);

      api.on('candle', (candle) => {
          io.to(uid).emit('price_update', { 
            pair: defaultPair, 
            price: candle.close.toFixed(5),
            timestamp: new Date().toLocaleTimeString()
          });
          
          // ANALISIS EN VIVO ESTRATEGIA ROBERT HERRERA
          const candles = api.getCandles(defaultPair, 1);
          if (candles.length > 20) {
              const rsi = calculateRSI(candles.map(c => c.close), 6);
              const cci = calculateCCI(candles, 14);
              if ((rsi < 30 && cci < -100) || (rsi > 70 && cci > 100)) {
                  const type = rsi < 30 ? 'CALL' : 'PUT';
                  io.to(uid).emit('signal', { type, rsi, cci, pair: defaultPair });
              }
          }
      });

      // Sincronizar saldos
      setInterval(async () => {
          if (!userSessions.has(uid)) return;
          try {
            const balances = await api.getBalances();
            const demo = balances.find(b => b.type === 4)?.amount || '0.00';
            const real = balances.find(b => b.type === 1)?.amount || '0.00';
            io.to(uid).emit('balance_sync', { demo, real });
          } catch (e) {}
      }, 15000);

    } catch (err) {
      console.error("❌ Error IQ:", err.message);
      socket.emit('iq_error', { msg: 'Fallo al conectar. Revisa tu cuenta o IP.' });
    }
  });

  // --- MOTOR DE BACKTESTING ULTRA-ESTABLE ---
  socket.on('run_backtest', async (data) => {
      const { uid, pair } = data;
      const session = userSessions.get(uid);
      if (!session) return;

      console.log(`🧪 Scaneando: ${pair}...`);
      try {
          // Método compatible para obtener velas históricas
          const candles = await session.api.getCandlesAsync(pair, 60, 500); 
          let wins = 0; let signals = 0;

          for (let i = 20; i < candles.length - 1; i++) {
              const slice = candles.slice(0, i + 1);
              const rsi = calculateRSI(slice.map(c => c.close), 6);
              const cci = calculateCCI(slice, 14);

              const isSignal = (rsi < 30 && cci < -100) || (rsi > 70 && cci > 100);
              if (isSignal) {
                  signals++;
                  const won = rsi < 30 ? (candles[i+1].close > candles[i].close) : (candles[i+1].close < candles[i].close);
                  if (won) wins++;
              }
          }

          const rate = signals > 0 ? ((wins / signals) * 100).toFixed(2) : 0;
          io.to(uid).emit('backtest_result', { pair, rate, totalSignals: signals });
      } catch (e) {
          console.error("Backtest Error:", e.message);
          io.to(uid).emit('iq_error', { msg: `No se pudo escanear ${pair}` });
      }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Cliente Desconectado`);
  });
});

const PORT = process.env.PORT || 8080; 
httpServer.listen(PORT, () => {
  console.log(`📡 Multi-User Hub Puerto ${PORT}`);
});
