import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'iq-option-client';
const { IQOptionApi } = pkg;
import admin from 'firebase-admin';

dotenv.config();

// Inicialización de Firebase Admin (Requiere Service Account JSON o variables de entorno)
// Por ahora, asumimos configuración mínima para no bloquear el inicio
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin Inicializado");
    } catch (e) {
        console.error("❌ Fallo Firebase Admin:", e.message);
    }
}

const app = express();
app.use(cors({ origin: "*" })); // Muy permisivo para no fallar en el despliegue

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { 
    origin: "*", // Permitir que la App de Firebase se comunique
    methods: ["GET", "POST"]
  }
});

// Almacén dinámico de conexiones por usuario (UID)
const userSessions = new Map();

const syncUserBalances = (uid, socket = null) => {
    const session = userSessions.get(uid);
    if (session && session.connected && session.profile) {
        const profile = session.profile;
        let demo = 0, real = 0;
        profile.balances.forEach(b => {
            if (b.type === 4) demo = b.amount;
            else if (b.type === 1) real = b.amount;
        });
        const data = { demo: demo.toFixed(2), real: real.toFixed(2) };
        if (socket) socket.emit('balance_sync', data);
        else io.to(uid).emit('balance_sync', data);
        return data;
    }
    return { demo: "10000.00", real: "0.00" };
};

io.on('connection', (socket) => {
  console.log('✅ Nuevo Socket vinculado');

  // Enlace del socket a un Usuario de Firebase
  socket.on('auth_link', async (uid) => {
      socket.join(uid);
      console.log(`🔗 Usuario ${uid} vinculado al socket`);
      if (userSessions.has(uid)) {
          syncUserBalances(uid, socket);
      }
  });

  socket.on('connect_iq', async (creds) => {
      const { uid, email, password, mode } = creds;
      console.log(`📡 Intentando conectar IQ para ${email} (UID: ${uid})...`);
      
      try {
          const api = new IQOptionApi(email, password);
          const profile = await api.connectAsync();
          
          userSessions.set(uid, {
              api,
              profile,
              connected: true,
              email
          });

          io.to(uid).emit('iq_connected', { name: profile.name, email });
          syncUserBalances(uid);
          console.log(`✅ ${profile.name} conectado exitosamente`);

      } catch (err) {
          console.error(`❌ Error IQ (${uid}):`, err.message);
          socket.emit('iq_error', { msg: 'Fallo al autenticar en IQ Option' });
      }
  });

  socket.on('execute_trade', async (data) => {
    const { uid, pair, amount } = data;
    const session = userSessions.get(uid);

    if (session && session.connected) {
        try {
            // Ejemplo disparo real
            await session.api.sendOrderBinary(pair.replace('/', ''), 'call', 60, 0, 90, amount);
            socket.emit('trade_result', { status: 'success', msg: 'Real order open' });
        } catch (err) {
            socket.emit('trade_result', { status: 'error', msg: 'Broker error' });
        }
    } else {
        // Fallback simulación
        setTimeout(() => {
            socket.emit('trade_result', { status: 'win', profit: amount * 0.85, msg: 'Simulada' });
        }, 1500);
    }
  });
});

const PORT = process.env.PORT || 8080; // Cloud cada vez más usa 8080 por defecto
httpServer.listen(PORT, () => {
  console.log(`📡 Multi-User Gateway (Cloud Ready) en Puerto ${PORT}`);
});

// Manejo de apagado limpio para no dejar trades colgados
process.on('SIGTERM', () => {
    console.log('🛑 Cerrando puente de trading por señal (Cloud)...');
    userSessions.forEach(s => {
        if (s.api && s.api.getIQOptionWs) s.api.getIQOptionWs().terminate();
    });
    process.exit(0);
});
