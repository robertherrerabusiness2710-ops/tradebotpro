import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'iq-option-client';
const { IQOptionApi } = pkg;
import admin from 'firebase-admin';

dotenv.config();

// CONFIGURACIÓN DE FIREBASE ADMIN (OPCIONAL EN ESTE PASO PERO RECOMENDADO)
// Si tienes el archivo serviceAccountKey.json, descomenta esto:
/*
import serviceAccount from "./serviceAccountKey.json" assert { type: "json" };
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
*/

const app = express();
app.use(cors({ origin: "*" })); 

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// Almacén dinámico de conexiones por usuario (UID)
const userSessions = new Map(); 

// --- FUNCIONES MATEMÁTICAS DE TRADING (ESTRATEGIA ROBERT HERRERA) ---

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
    const typicalPrices = candles.slice(-period).map(c => (c.max + c.min + c.close) / 3);
    const sma = typicalPrices.reduce((a, b) => a + b, 0) / period;
    const meanDev = typicalPrices.map(tp => Math.abs(tp - sma)).reduce((a, b) => a + b, 0) / period;
    if (meanDev === 0) return 0;
    return (typicalPrices[typicalPrices.length - 1] - sma) / (0.015 * meanDev);
}

// ------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log(`🔌 Cliente Conectado: ${socket.id}`);

  // Vincular Socket con UID de Firebase
  socket.on('auth_link', (uid) => {
    socket.join(uid);
    console.log(`👤 Usuario ${uid} vinculado a Socket ${socket.id}`);
  });

  // Conexión al Broker (IQ Option)
  socket.on('connect_iq', async (creds) => {
    const { uid, email, password, mode } = creds;
    console.log(`⏳ Intentando conectar IQ para ${email} (UID: ${uid})...`);
    
    try {
      const api = new IQOptionApi(email, password);
      // Timeout de 30 segundos para no quedar cargando por siempre
      const connectPromise = api.connectAsync();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000));
      
      const profile = await Promise.race([connectPromise, timeoutPromise]);
      
      userSessions.set(uid, { api, email, mode });
      io.to(uid).emit('iq_connected', { name: profile.name, email });
      console.log(`✅ Conexión Exitosa: ${profile.name}`);

      // Suscribirse a EUR/USD-OTC por defecto
      const activePair = 'EURUSD-OTC';
      await api.subscribeCandles(activePair, 1); // 1 = M1

      api.on('candle', (candle) => {
          // Cada nueva vela, enviamos precios y analizamos estrategia
          io.to(uid).emit('price_update', { 
            pair: activePair, 
            price: candle.close.toFixed(5),
            timestamp: new Date().toLocaleTimeString()
          });
          
          // --- ANALIZADOR DE ESTRATEGIA ROBERT HERRERA v1 ---
          const candles = api.getCandles(activePair, 1);
          if (candles.length > 20) {
              const closes = candles.map(c => c.close);
              const rsi = calculateRSI(closes, 6);
              const cci = calculateCCI(candles, 14);
              
              const isCall = rsi < 30 && cci < -100;
              const isPut = rsi > 70 && cci > 100;

              if (isCall) io.to(uid).emit('signal', { type: 'CALL', rsi, cci, pair: activePair });
              if (isPut) io.to(uid).emit('signal', { type: 'PUT', rsi, cci, pair: activePair });
          }
      });

      // Sincronizar saldos cada 10 segundos
      const balanceInterval = setInterval(async () => {
          if (!userSessions.has(uid)) return clearInterval(balanceInterval);
          try {
            const balances = await api.getBalances();
            const demo = balances.find(b => b.type === 4)?.amount || '0.00';
            const real = balances.find(b => b.type === 1)?.amount || '0.00';
            io.to(uid).emit('balance_sync', { demo, real });
          } catch (e) { console.error("Balance sync error", e); }
      }, 10000);

    } catch (err) {
      console.error("❌ Error IQ:", err.message);
      socket.emit('iq_error', { msg: 'Fallo al autenticar o IP bloqueada. Prueba con Glitch/Túnel.' });
    }
  });

  // --- MOTOR DE BACKTESTING ---
  socket.on('run_backtest', async (data) => {
      const { uid, pair = 'EURUSD-OTC' } = data;
      const session = userSessions.get(uid);
      if (!session) return;

      console.log(`🧪 Iniciando Backtest para ${pair}...`);
      try {
          const candles = await session.api.getCandlesAsync(pair, 60, 500); // 500 velas M1
          let wins = 0;
          let losses = 0;
          let totalSignals = 0;

          for (let i = 20; i < candles.length - 1; i++) {
              const slice = candles.slice(0, i + 1);
              const closes = slice.map(c => c.close);
              const rsi = calculateRSI(closes, 6);
              const cci = calculateCCI(slice, 14);

              const isCall = rsi < 30 && cci < -100;
              const isPut = rsi > 70 && cci > 100;

              if (isCall || isPut) {
                  totalSignals++;
                  const nextCandle = candles[i + 1];
                  const won = isCall ? (nextCandle.close > candles[i].close) : (nextCandle.close < candles[i].close);
                  if (won) wins++; else losses++;
              }
          }

          const rate = totalSignals > 0 ? ((wins / totalSignals) * 100).toFixed(2) : 0;
          io.to(uid).emit('backtest_result', { pair, rate, totalSignals });
      } catch (e) {
          console.error("Backtest Error", e);
      }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Cliente Desconectado: ${socket.id}`);
  });
});

// Cloud Ready (Render/Heroku usará PORT, Glitch también)
const PORT = process.env.PORT || 8080; 
httpServer.listen(PORT, () => {
  console.log(`📡 Multi-User Gateway (Trading Engine) en Puerto ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('Terminando procesos...');
  process.exit(0);
});
