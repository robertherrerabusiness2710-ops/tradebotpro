import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, Settings, Play, Database, Shield, Zap, 
  TrendingUp, RefreshCw, LogOut, CheckCircle2, AlertCircle,
  Globe, Server, User, Key, Mail, Cpu, Clock, DollarSign
} from 'lucide-react';
import { io } from 'socket.io-client';
import { auth, db } from './lib/firebase';
import { onAuthStateChanged, signOut, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { collection, addDoc, onSnapshot, query, orderBy, limit, serverTimestamp } from 'firebase/firestore';

// ==========================================
// CONFIGURACIÓN DE NÚCLEO (BLINDAJE v6.2)
// ==========================================

const App = () => {
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('panel');
  const [gatewayUrl, setGatewayUrl] = useState(
    localStorage.getItem('trade_gateway') || 
    import.meta.env.VITE_GATEWAY_URL || 
    ''
  );
  const [balances, setBalances] = useState({ real: '0.00', demo: '0.00' });
  const [logs, setLogs] = useState([]);
  const [socketStatus, setSocketStatus] = useState('offline');
   const [isLinking, setIsLinking] = useState(false);
  const [brokerConnected, setBrokerConnected] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  
  // ESTADOS DE ESTRATEGIA (RSI + CCI)
  const [isTesting, setIsTesting] = useState(false);
  const [testResults, setTestResults] = useState(null);
  const [backtestConfig, setBacktestConfig] = useState({ account: 'demo', amount: 10, cycles: 10 });
  const [backtestPhase, setBacktestPhase] = useState('');
  const [scanTelemetry, setScanTelemetry] = useState([]);
  const [tradeHistory, setTradeHistory] = useState(JSON.parse(localStorage.getItem('trade_history') || '[]'));
  const [multiPrices, setMultiPrices] = useState([]);
  const [historyFilter, setHistoryFilter] = useState('all');
  const [cycleReport, setCycleReport] = useState(null);
  const [liveTrades, setLiveTrades] = useState(JSON.parse(localStorage.getItem('live_trades') || '[]'));
  
  // NUEVO: Oportunidades Cercanas, Bitácora y Calendario
  const [nearMisses, setNearMisses] = useState(JSON.parse(localStorage.getItem('near_misses') || '[]'));
  const [dailyLogs, setDailyLogs] = useState(JSON.parse(localStorage.getItem('daily_logs') || '{}'));
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState(null);
  const socketRef = useRef(null);
  const iqEmailRef = useRef(null);
  const iqPassRef = useRef(null);
  const gatewayInputRef = useRef(null);
  
  // FIX: Ref approach for backtestConfig to prevent old closure bugs
  const backtestConfigRef = useRef(backtestConfig);
  useEffect(() => { backtestConfigRef.current = backtestConfig; }, [backtestConfig]);

  // 1. GESTIÓN DE AUTENTICACIÓN FIREBASE
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  const addLog = React.useCallback(async (text) => {
    if (!user) return;
    await addDoc(collection(db, `logs_${user.uid}`), {
      text,
      time: new Date().toLocaleTimeString(),
      createdAt: serverTimestamp(),
      type: text.includes('✅') ? 'success' : text.includes('❌') ? 'error' : 'info'
    });
  }, [user]);

  // 2. CONEXIÓN SOCKET DINÁMICA
  useEffect(() => {
    if (!user || !gatewayUrl) return;

    if (socketRef.current) socketRef.current.disconnect();

    try {
      socketRef.current = io(gatewayUrl, { 
        transports: ['websocket'], 
        reconnection: true,
        path: '/socket.io'
      });

      socketRef.current.on('connect', () => {
        setSocketStatus('online');
        addLog("📶 Enlace Activo: " + gatewayUrl);
        socketRef.current.emit('auth_link', user.uid);
      });

      socketRef.current.on('disconnect', () => setSocketStatus('offline'));
      
      socketRef.current.on('balance_sync', (data) => {
        setBalances(data);
      });

      socketRef.current.on('iq_connected', (data) => {
        addLog(`✅ Broker conectado como: ${data.name}`);
        setIsLinking(false);
        setBrokerConnected(true);
        setSuccessMsg("¡VINCULACION EXITOSA! 🎉");
        setTimeout(() => setSuccessMsg(''), 5000);
      });

      socketRef.current.on('iq_error', (data) => {
        addLog(`❌ Error IQ: ${data.msg}`);
        setIsLinking(false);
      });

      socketRef.current.on('scan_telemetry', (data) => {
        // Merge new data with existing - never remove coins already shown
        setScanTelemetry(prev => {
          const existing = new Map(prev.map(item => [item.asset, item]));
          (data.results || []).forEach(item => existing.set(item.asset, item));
          return Array.from(existing.values());
        });
      });

      socketRef.current.on('scan_init', (data) => {
        // Inicializar barras con TODOS los activos al empezar
        if (data.assets && data.assets.length > 0) {
          setScanTelemetry(data.assets);
        }
      });

      socketRef.current.on('price_multi_update', (data) => {
        setMultiPrices(data.prices);
      });

      socketRef.current.on('trade_executed', (data) => {
        setTradeHistory(prev => {
          const updated = [data, ...prev].slice(0, 50);
          localStorage.setItem('trade_history', JSON.stringify(updated));
          return updated;
        });
        addLog(`🎯 DISPARO REALIZADO: ${data.asset} (${data.side})`);
      });

      socketRef.current.on('live_trade_result', (data) => {
        // Agregar hora actual al resultado
        const withTime = { ...data, displayTime: new Date().toLocaleTimeString(), date: new Date().toLocaleDateString() };
        
        setLiveTrades(prev => {
            const updated = [withTime, ...prev].slice(0, 10);
            localStorage.setItem('live_trades', JSON.stringify(updated));
            return updated;
        });

        const isWin = data.result && data.result.includes('GANADA');
        addLog(`${isWin ? '✅ GANADA' : '❌ PERDIDA'}: ${data.asset}`);
        // La bitácora ahora se actualiza por CICLO COMPLETO en live_bot_finished, no por operación individual
      });

      socketRef.current.on('near_miss', (data) => {
        setNearMisses(prev => {
          const updated = [data, ...prev].slice(0, 20);
          localStorage.setItem('near_misses', JSON.stringify(updated));
          return updated;
        });
      });

      socketRef.current.on('live_bot_update', (data) => {
        setBacktestPhase(data.phase);
        if (data.w !== undefined) {
          const currentConfig = backtestConfigRef.current;
          const w = data.w ?? 0;
          const l = data.l ?? 0;
          const total = data.trades ?? 0;
          const netProfit = (w * currentConfig.amount * 0.85) - (l * currentConfig.amount);
          setTestResults(prev => ({ 
            // Preserve fields from previous complete result (like accountUsed, amountUsed)
            ...(prev || {}),
            wins: w, 
            losses: l, 
            trades: total,
            total: total,
            winRate: total > 0 ? parseFloat(((w / total) * 100).toFixed(1)) : 0,
            profit: netProfit >= 0 ? `+ $${netProfit.toFixed(2)}` : `- $${Math.abs(netProfit).toFixed(2)}`,
            isPositive: netProfit >= 0,
            amountUsed: currentConfig.amount,
            accountUsed: currentConfig.account.toUpperCase(),
            report: data.report || [] 
          }));
        }
      });

      socketRef.current.on('bot_restored_state', (data) => {
        setIsTesting(true);
        setBacktestPhase(data.phase || 'Restaurando Sesión...');
        
        // Ensure config is restored
        const restoredConfig = { account: data.account, amount: data.amount, cycles: data.cycles };
        setBacktestConfig(restoredConfig);
        backtestConfigRef.current = restoredConfig;

        if (data.w !== undefined) {
          setTestResults({ 
            wins: data.w, 
            losses: data.l, 
            total: data.trades, 
            profit: (data.w * data.amount * 0.85) - (data.l * data.amount),
            report: data.report || []
          });
        }
      });

      socketRef.current.on('live_bot_finished', (data) => {
        setIsTesting(false);
        setBacktestPhase('');
        if (data.report) setCycleReport(data.report);

        // Calcular resultados finales del ciclo
        const currentConfig = backtestConfigRef.current;
        const winCount = data.w || 0;
        const lossCount = data.l || 0;
        const totalTrades = data.trades || 0;
        const winRate = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(1) : '0.0';
        const profitPerWin = currentConfig.amount * 0.85;
        const netProfit = (winCount * profitPerWin) - (lossCount * currentConfig.amount);

        setTestResults({
          trades: totalTrades,
          wins: winCount,
          losses: lossCount,
          winRate: parseFloat(winRate),
          profit: netProfit >= 0 ? `+ $${netProfit.toFixed(2)}` : `- $${Math.abs(netProfit).toFixed(2)}`,
          isPositive: netProfit >= 0,
          amountUsed: currentConfig.amount,
          accountUsed: currentConfig.account.toUpperCase(),
          report: data.report || []
        });

        // GUARDAR CICLO COMPLETO EN BITÁCORA CON DEDUPLICACIÓN
        const today = new Date().toLocaleDateString();
        const cycleEntry = {
          id: data.id || Date.now(),
          startTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          account: currentConfig.account.toUpperCase(),
          amount: currentConfig.amount,
          wins: winCount,
          losses: lossCount,
          profit: netProfit,
          trades: (data.report || []).map(t => ({
            asset: t.asset,
            side: t.side,
            result: t.result || 'PROCESANDO...',
            rsi: t.rsi,
            cci: t.cci,
            time: t.time
          }))
        };

        setDailyLogs(prev => {
          const dayData = prev[today] || { cycles: [], totalWins: 0, totalLosses: 0, totalProfit: 0 };
          const existingCycles = dayData.cycles || [];
          
          // Deduplicar ciclos por ID para evitar duplicaciones
          const existsIdx = existingCycles.findIndex(c => c.id === cycleEntry.id);
          let newCycles = [...existingCycles];
          if (existsIdx >= 0) {
            newCycles[existsIdx] = cycleEntry;
          } else {
            newCycles.push(cycleEntry);
          }

          // Recalcular totales del día
          const totalWins = newCycles.reduce((sum, c) => sum + (c.wins || 0), 0);
          const totalLosses = newCycles.reduce((sum, c) => sum + (c.losses || 0), 0);
          const totalProfit = newCycles.reduce((sum, c) => sum + (c.profit || 0), 0);

          const updatedDay = {
            cycles: newCycles,
            totalWins,
            totalLosses,
            totalProfit
          };

          const nextState = { ...prev, [today]: updatedDay };
          localStorage.setItem('daily_logs', JSON.stringify(nextState));
          return nextState;
        });

        addLog(`📊 CICLO FINALIZADO: ${winCount}G - ${lossCount}P | Net: $${netProfit.toFixed(2)}`);
      });
    } catch {
      addLog("❌ Error: Gateway inalcanzable");
    }

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, [user, gatewayUrl, addLog]);

  // FALLBACK LOCAL: Obtener precios de BTC/ETH/SOL directamente de Binance si el socket no los provee
  useEffect(() => {
    const fetchDirectPrices = async () => {
      if (multiPrices.length > 0) return;
      try {
        const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
        const results = await Promise.all(symbols.map(async (sym) => {
          const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
          const data = await res.json();
          return {
            pair: sym.replace('USDT', ''),
            price: parseFloat(data.price).toLocaleString('en-US', { minimumFractionDigits: 2 }),
            timestamp: new Date().toLocaleTimeString()
          };
        }));
        setMultiPrices(results);
      } catch(e) {}
    };
    
    fetchDirectPrices();
    const interval = setInterval(fetchDirectPrices, 10000);
    return () => clearInterval(interval);
  }, [multiPrices.length]);

  // 3. RECUPERACIÓN DE LOGS HISTÓRICOS
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, `logs_${user.uid}`), orderBy('createdAt', 'desc'), limit(15));
    const unsub = onSnapshot(q, (snap) => {
      setLogs(snap.docs.map(doc => doc.data()));
    });
    return () => unsub();
  }, [user]);

  // addLog was hoisted up to avoid ESLint warnings and early access

  const updateGateway = () => {
    const newUrl = gatewayInputRef.current?.value;
    if (newUrl) {
      localStorage.setItem('trade_gateway', newUrl);
      setGatewayUrl(newUrl);
      setSuccessMsg("¡ENLACE NUBE GUARDADO! ✅");
      setTimeout(() => setSuccessMsg(''), 3000);
    }
  };

  const handleBrokerConnect = (e) => {
    e.preventDefault();
    if (!socketRef.current) return addLog("❌ Error: Socket offline");

    const email = iqEmailRef.current?.value;
    const pass = iqPassRef.current?.value;

    if (!email || !pass) return alert("Por favor completa los datos de IQ Option");

    localStorage.setItem('iq_email', email);
    localStorage.setItem('iq_pass', pass);

    setIsLinking(true);
    setSuccessMsg("⏳ SINCRONIZANDO CON EL CORREDOR...");
    
    socketRef.current.emit('connect_iq', {
      uid: user.uid,
      email: email,
      password: pass
    });
  };

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login Error:", error);
    }
  };

  const runBacktest = () => {
    if(!backtestConfig.amount || backtestConfig.amount < 1) return alert("Ingresa un monto válido");
    
    setIsTesting(true);
    setTestResults(null);
    setBacktestPhase('Conectando a Motor de Operaciones en Vivo...');

    if (socketRef.current) {
        socketRef.current.emit('start_live_bot', { 
            account: backtestConfig.account, 
            amount: backtestConfig.amount,
            cycles: backtestConfig.cycles
        });
    } else {
        alert("El motor no está conectado. Reinicia el enlace.");
        setIsTesting(false);
    }
  };
  

  // NOTE: Los eventos live_bot_update y live_bot_finished ya están registrados
  // en el useEffect principal de conexión (líneas 112-129). No se duplican aquí.


  if (!user) return (
    <div className="min-h-screen bg-[#080b13] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-[#0d121f]/80 backdrop-blur-xl border border-blue-500/20 rounded-3xl p-8 shadow-2xl text-center">
        <div className="flex items-center justify-center gap-3 mb-8">
          <Activity className="w-10 h-10 text-blue-500" />
          <h1 className="text-3xl font-black text-white tracking-tighter italic">TRADEBOT PRO</h1>
        </div>
        <p className="text-gray-400 mb-8 text-sm">Bienvenido Robert, ingresa a tu terminal de trading en la nube.</p>
        <button 
          onClick={handleLogin}
          className="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-3 hover:bg-blue-500 transition-all transform active:scale-95 shadow-lg shadow-blue-500/20"
        >
          <User className="w-5 h-5" /> Iniciar con Google Cloud
        </button>
        <button
          onClick={() => setUser({ uid: 'demo_user_123', displayName: 'Robert Herrera' })}
          id="developer-bypass-login"
          className="w-full mt-4 bg-white/5 text-gray-400 hover:text-white font-bold py-3 rounded-2xl flex items-center justify-center gap-2 hover:bg-white/10 transition-all text-xs border border-white/5 uppercase tracking-wider"
        >
          Acceso Rápido Desarrollador (Bypass)
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#080b13] text-gray-200 font-sans">
      
      {successMsg && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[999] bg-green-500 text-white px-8 py-4 rounded-full font-black shadow-2xl flex items-center gap-3 animate-bounce border-2 border-white/20">
          <CheckCircle2 className="w-6 h-6" /> {successMsg}
        </div>
      )}

      <aside className="fixed left-0 top-0 h-full w-20 md:w-64 bg-[#0d121f] border-r border-blue-500/10 flex flex-col z-50">
        <div className="p-6 flex items-center gap-3">
          <Activity className="w-6 h-6 text-blue-500" />
          <span className="hidden md:block font-black text-white tracking-tighter italic text-xl uppercase">TradeBot Pro</span>
        </div>

        <nav className="flex-1 px-4 mt-6 space-y-2">
          {[
            { id: 'panel', icon: Database, label: 'DASHBOARD' },
            { id: 'estrategias', icon: Zap, label: 'STRATEGIES' },
            { id: 'ajustes', icon: Settings, label: 'SETTINGS' },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center gap-4 p-4 rounded-2xl transition-all ${
                activeTab === item.id 
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30' 
                : 'hover:bg-blue-500/5 text-gray-500'
              }`}
            >
              <item.icon className="w-6 h-6" />
              <span className="hidden md:block font-bold text-xs tracking-widest">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="p-6 border-t border-white/5">
          <button 
            onClick={() => signOut(auth)}
            className="w-full flex items-center gap-4 p-4 rounded-2xl text-red-500 hover:bg-red-500/10 transition-all font-bold text-xs"
          >
            <LogOut className="w-6 h-6" />
            <span className="hidden md:block">LOGOUT</span>
          </button>
          <div className="mt-4 text-[9px] text-gray-600 font-mono text-center tracking-tighter uppercase">SYSTEM v6.5 - PERSISTENCE MAX</div>
        </div>
      </aside>

      <main className="pl-20 md:pl-64 min-h-screen">
        <header className="sticky top-0 bg-[#080b13]/90 backdrop-blur-md p-6 border-b border-white/5 z-40 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`w-3 h-3 rounded-full ${socketStatus === 'online' ? 'bg-green-500 shadow-[0_0_10px_#22c55e]' : 'bg-red-500'}`} />
            <span className="text-[10px] uppercase font-black tracking-widest text-gray-400">
              GATEWAY: {socketStatus === 'online' ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>

          <div className="flex gap-4">
             <div className="bg-[#0d121f] border border-blue-500/10 rounded-2xl p-4 min-w-[140px]">
                <div className="text-[8px] text-gray-500 font-bold mb-1 uppercase tracking-widest">REAL ACCOUNT</div>
                <div className="text-green-400 font-black text-lg">$ {balances.real}</div>
             </div>
             <div className="bg-[#0d121f] border border-orange-500/10 rounded-2xl p-4 min-w-[140px]">
                <div className="text-[8px] text-gray-500 font-bold mb-1 uppercase tracking-widest">DEMO ACCOUNT</div>
                <div className="text-orange-400 font-black text-lg">$ {balances.demo}</div>
             </div>
          </div>
        </header>

        <div className="p-8">
          {activeTab === 'panel' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 space-y-8">
                {/* MONITOR CRIPTO (LAS 3 MADRES) */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                   {multiPrices.length > 0 ? multiPrices.map((p, i) => (
                     <div key={i} className="bg-[#0d121f] border border-blue-500/10 rounded-3xl p-6 hover:border-blue-500/30 transition-all group overflow-hidden relative">
                        <div className="absolute -right-4 -bottom-4 opacity-5 group-hover:opacity-10 transition-opacity">
                           {p.pair.includes('BTC') ? <DollarSign className="w-24 h-24 text-orange-400" /> : <Shield className="w-24 h-24 text-blue-400" />}
                        </div>
                        <div className="relative z-10">
                           <div className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2 flex items-center gap-2">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> {p.pair}
                           </div>
                           <div className="text-3xl font-black text-white italic tracking-tighter">${p.price}</div>
                           <div className="text-[9px] text-gray-600 font-bold mt-2 uppercase">{p.timestamp}</div>
                        </div>
                     </div>
                   )) : (
                     [1,2,3].map(i => (
                       <div key={i} className="bg-[#0d121f] border border-white/5 rounded-3xl p-6 animate-pulse">
                          <div className="h-4 bg-white/5 w-20 rounded mb-4" />
                          <div className="h-8 bg-white/5 w-32 rounded" />
                       </div>
                     ))
                   )}
                </div>

                {/* Bitácora Diaria - CALENDARIO */}
                <div className="bg-[#0d121f] rounded-[40px] border border-white/5 p-8">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h3 className="text-2xl font-black text-white italic tracking-tighter uppercase">Bitácora Diaria</h3>
                          <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mt-1">
                            {calendarMonth.toLocaleString('es-ES', {month: 'long', year: 'numeric'}).toUpperCase()}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => setCalendarMonth(prev => new Date(prev.getFullYear(), prev.getMonth()-1))} className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 text-white font-black flex items-center justify-center transition-all">‹</button>
                          <button onClick={() => setCalendarMonth(prev => new Date(prev.getFullYear(), prev.getMonth()+1))} className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 text-white font-black flex items-center justify-center transition-all">›</button>
                          <button onClick={() => { setDailyLogs({}); localStorage.removeItem('daily_logs'); setSelectedDay(null); }} className="text-[9px] font-black text-red-500 hover:text-red-400 border border-red-500/30 px-3 py-1.5 rounded-xl uppercase tracking-widest transition-all ml-2">Limpiar</button>
                        </div>
                      </div>

                      <div className="grid grid-cols-7 gap-1 mb-1">
                        {['DOM','LUN','MAR','MIÉ','JUE','VIE','SÁB'].map(d => (
                          <div key={d} className="text-center text-[8px] font-black text-gray-600 uppercase tracking-widest py-1">{d}</div>
                        ))}
                      </div>

                      <div className="grid grid-cols-7 gap-1">
                        {Array.from({length: new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1).getDay()}).map((_, i) => (
                          <div key={`e-${i}`} className="aspect-square rounded-xl" />
                        ))}
                        {Array.from({length: new Date(calendarMonth.getFullYear(), calendarMonth.getMonth()+1, 0).getDate()}).map((_, i) => {
                          const dayNum = i + 1;
                          const cellDate = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), dayNum);
                          const dateKey = cellDate.toLocaleDateString();
                          const dayData = dailyLogs[dateKey];
                          const isToday = new Date().toLocaleDateString() === dateKey;
                          const isSelected = selectedDay === dateKey;
                          const profit = dayData?.totalProfit || 0;
                          const hasTrades = dayData && dayData.cycles && dayData.cycles.length > 0;
                          return (
                            <button key={dayNum} onClick={() => setSelectedDay(isSelected ? null : dateKey)}
                              className={`aspect-square rounded-xl p-1 flex flex-col items-center justify-center transition-all ${
                                hasTrades
                                  ? profit >= 0 ? 'bg-green-500/15 border border-green-500/50 hover:border-green-400' : 'bg-red-500/15 border border-red-500/50 hover:border-red-400'
                                  : isToday ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-white/3 border border-white/5 hover:bg-white/5'
                              } ${isSelected ? 'ring-2 ring-blue-400' : ''}`}>
                              <span className="text-[10px] font-black text-gray-300">{dayNum}</span>
                              {hasTrades && <span className={`text-[8px] font-black leading-tight ${profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{profit >= 0 ? '+' : '-'}${Math.abs(profit).toFixed(0)}</span>}
                            </button>
                          );
                        })}
                      </div>

                      {(() => {
                        const mk = Object.keys(dailyLogs).filter(k => { try { const d = new Date(k); return d.getMonth()===calendarMonth.getMonth() && d.getFullYear()===calendarMonth.getFullYear(); } catch(e){return false;} });
                        const mProfit = mk.reduce((s,k) => s+(dailyLogs[k]?.totalProfit||0), 0);
                        const mCycles = mk.reduce((s,k) => s+(dailyLogs[k]?.cycles?.length||0), 0);
                        return mCycles > 0 ? (
                          <div className="mt-4 pt-4 border-t border-white/5 flex justify-between items-center">
                            <span className="text-[10px] text-gray-500 uppercase font-bold tracking-widest">{mCycles} ciclo{mCycles!==1?'s':''} este mes</span>
                            <span className={`text-lg font-black ${mProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{mProfit >= 0 ? '+' : '-'}${Math.abs(mProfit).toFixed(2)}</span>
                          </div>
                        ) : null;
                      })()}

                      {selectedDay && dailyLogs[selectedDay] && (
                        <div className="mt-6 pt-6 border-t border-white/10 space-y-4 max-h-[500px] overflow-y-auto custom-scrollbar">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-black text-white uppercase tracking-tight">📅 {selectedDay}</span>
                            <div className="flex gap-3 text-[10px] font-black">
                              <span className="text-green-400">✅ {dailyLogs[selectedDay].totalWins} Ganadas</span>
                              <span className="text-red-400">❌ {dailyLogs[selectedDay].totalLosses} Perdidas</span>
                            </div>
                          </div>
                          {(dailyLogs[selectedDay].cycles || []).map((cycle, ci) => (
                            <div key={cycle.id} className="bg-white/5 rounded-2xl p-4 border border-white/5">
                              <div className="flex justify-between items-center mb-3">
                                <div>
                                  <div className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Ciclo {ci+1} · {cycle.startTime} · {cycle.account}</div>
                                  <div className="text-[9px] text-gray-600 font-bold mt-0.5">Inv: ${cycle.amount} por op · {cycle.wins}G / {cycle.losses}P</div>
                                </div>
                                <div className="flex items-center gap-3">
                                  <span className={`text-sm font-black ${cycle.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{cycle.profit >= 0 ? '+' : '-'}${Math.abs(cycle.profit).toFixed(2)}</span>
                                  <button
                                    onClick={() => {
                                      setDailyLogs(prev => {
                                        const dayData = prev[selectedDay];
                                        if (!dayData) return prev;
                                        const newCycles = dayData.cycles.filter(c => c.id !== cycle.id);
                                        const totalWins = newCycles.reduce((s,c) => s+(c.wins||0), 0);
                                        const totalLosses = newCycles.reduce((s,c) => s+(c.losses||0), 0);
                                        const totalProfit = newCycles.reduce((s,c) => s+(c.profit||0), 0);
                                        const updated = { ...prev, [selectedDay]: { cycles: newCycles, totalWins, totalLosses, totalProfit } };
                                        localStorage.setItem('daily_logs', JSON.stringify(updated));
                                        return updated;
                                      });
                                    }}
                                    className="w-6 h-6 flex items-center justify-center rounded-full bg-red-500/10 hover:bg-red-500/30 text-red-500 hover:text-red-400 transition-all text-xs font-black border border-red-500/20"
                                    title="Eliminar este ciclo"
                                  >×</button>
                                </div>
                              </div>
                              <div className="space-y-1">
                                {(cycle.trades || []).map((t, ti) => (
                                  <div key={ti} className="flex justify-between items-center text-[9px] px-3 py-2 rounded-xl bg-white/3">
                                    <span className="font-black text-white uppercase truncate max-w-[100px]">{t.asset}</span>
                                    <span className="text-gray-500 font-bold">{t.side} · RSI {t.rsi} CCI {t.cci}</span>
                                    <span className={`font-black whitespace-nowrap ${t.result?.includes('GANADA') ? 'text-green-400' : t.result?.includes('PERDIDA') ? 'text-red-400' : 'text-yellow-400'}`}>{t.result}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                 </div>

                {/* HISTORIAL POR ACTIVO */}
                <div className="bg-[#0d121f] rounded-[40px] border border-white/5 p-8 overflow-hidden flex flex-col h-[500px]">
                    <div className="flex flex-col md:flex-row justify-between items-center mb-8 gap-4">
                       <div>
                          <h3 className="text-2xl font-black text-white italic tracking-tighter uppercase">Historial de Caza</h3>
                          <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Ejecuciones en tiempo real</p>
                       </div>
                       
                       <div className="flex gap-2 bg-black/40 p-1.5 rounded-2xl border border-white/5 overflow-x-auto no-scrollbar max-w-full">
                          {['all', 'Amazon', 'AIG', 'FR 40', 'HK 33', 'SP 35', 'GER 30', 'BTC', 'ETH', 'SOL', 'Pepe', 'Ripple', 'Jupiter', 'Floki'].map(f => (
                            <button 
                              key={f}
                              onClick={() => setHistoryFilter(f)}
                              className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all shrink-0 ${
                                historyFilter === f 
                                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' 
                                : 'text-gray-500 hover:text-white'
                              }`}
                            >
                              {f}
                            </button>
                          ))}
                       </div>
                    </div>

                    <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                       {tradeHistory
                          .filter(t => {
                            const assetLower = (t.asset || '').toLowerCase();
                            if (assetLower.includes('eur/') || assetLower.includes('gbp/') || assetLower.includes('/jpy')) return false;
                            if (historyFilter !== 'all' && !(t.asset || '').includes(historyFilter)) return false;
                            return true;
                          }).length === 0 ? (
                         <div className="h-full flex flex-col items-center justify-center opacity-10">
                            <Database className="w-16 h-16 mb-4" />
                            <span className="text-[10px] uppercase font-black tracking-widest">Esperando primeras entradas...</span>
                         </div>
                       ) : (
                         tradeHistory
                          .filter(t => {
                            const assetLower = (t.asset || '').toLowerCase();
                            if (assetLower.includes('eur/') || assetLower.includes('gbp/') || assetLower.includes('/jpy')) return false;
                            if (historyFilter !== 'all' && !(t.asset || '').includes(historyFilter)) return false;
                            return true;
                          })
                          .map((t, idx) => (
                           <div key={idx} className="bg-white/5 hover:bg-white/10 p-5 rounded-3xl border border-white/5 flex items-center group transition-all animate-in slide-in-from-left-2">
                              <div className={`w-2 h-10 rounded-full ${t.side === 'CALL' ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.3)]' : 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]'} mr-6`} />
                              <div className="flex-1">
                                 <div className="text-xs font-black text-white group-hover:text-blue-400 transition-colors uppercase tracking-tight">{t.asset}</div>
                                 <div className="text-[9px] text-gray-500 font-bold mt-1 uppercase">
                                    PRECISIÓN: RSI {t.rsi} | CCI {t.cci}
                                 </div>
                              </div>
                              <div className="text-right">
                                 <div className={`text-sm font-black italic ${t.side === 'CALL' ? 'text-green-500' : 'text-red-500'}`}>{t.side === 'CALL' ? '↑ COMPRA' : '↓ VENTA'}</div>
                                 <div className="text-[9px] text-gray-600 font-black mt-1 uppercase">{t.time}</div>
                              </div>
                           </div>
                         ))
                       )}
                    </div>
                </div>
              </div>

              <div className="space-y-8">
                <div className="bg-[#0d121f] border border-white/5 rounded-[40px] flex flex-col h-[750px]">
                  <div className="p-8 border-b border-white/5 space-y-4">
                    <h3 className="font-black text-xs tracking-[0.3em] uppercase opacity-50">Monitor Ninja Cloud</h3>
                    
                    {/* LIVE TRADES RADAR (NUEVO) */}
                    <div className="space-y-2">
                       {liveTrades.length > 0 ? liveTrades.map((t, i) => (
                         <div key={i} className="bg-white/5 p-3 rounded-2xl border border-white/5 flex items-center justify-between animate-in slide-in-from-top-2">
                            <div className="flex items-center gap-3">
                               <div className={`w-1.5 h-6 rounded-full ${t.winner ? 'bg-green-500' : 'bg-red-500'}`} />
                               <div>
                                 <span className="text-[9px] font-black text-white uppercase block">{t.asset}</span>
                                 <span className="text-[8px] text-gray-500 font-bold">{t.displayTime || t.time || new Date().toLocaleTimeString()}</span>
                               </div>
                            </div>
                            <span className={`text-[8px] font-black uppercase ${t.winner ? 'text-green-500' : 'text-red-500'}`}>
                               {t.winner ? '✅ WIN' : '❌ LOSS'}
                            </span>
                         </div>
                       )) : (
                         <div className="text-[8px] text-gray-600 font-bold uppercase text-center py-2 opacity-50">Esperando Resultados Live...</div>
                       )}
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-8 space-y-6 font-mono text-[11px]">
                    {/* HORARIOS RECOMENDADOS */}
                    <div className="bg-blue-500/10 border border-blue-500/20 p-5 rounded-3xl group hover:bg-blue-500/20 transition-all">
                      <div className="flex items-center gap-3 mb-3">
                        <Clock className="w-4 h-4 text-blue-400" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-blue-400">Trading Safe-Window</span>
                      </div>
                      <div className="text-xs font-black text-blue-100 italic mb-1">08:30 - 15:00 UTC</div>
                      <div className="text-[9px] text-blue-400/60 font-bold uppercase leading-relaxed">Máxima liquidez, menor volatilidad algorítmica.</div>
                    </div>

                    {logs.map((log, i) => (
                      <div key={i} className="flex gap-4 border-l border-blue-500/20 pl-4 py-1 animate-in fade-in slide-in-from-left-1">
                        <span className="text-gray-600 shrink-0">{log.time}</span>
                        <span className={log.text.includes('❌') ? 'text-red-400' : log.text.includes('✅') ? 'text-green-400' : 'text-blue-300'}>
                          {log.text}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'estrategias' && (
            <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in zoom-in duration-500">
               <div>
                  <h2 className="text-4xl font-black text-white italic tracking-tighter uppercase mb-2">Estrategias</h2>
                  <p className="text-gray-500 font-medium">Motor de backtesting y señales en vivo.</p>
               </div>

               <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                 <div className="space-y-8">
                 {/* Tarjeta de Estrategia */}
                 <div className="bg-[#0d121f] rounded-[40px] border border-blue-500/20 p-8 shadow-[0_0_30px_rgba(0,100,255,0.1)] relative overflow-hidden group">
                    <div className="absolute top-0 right-0 p-8 opacity-20 group-hover:opacity-40 transition-opacity">
                      <Zap className="w-32 h-32 text-blue-500" />
                    </div>
                    
                    <div className="relative z-10">
                      <div className="bg-blue-600 text-white text-[10px] font-black px-4 py-1 rounded-full uppercase tracking-widest inline-block mb-6">VIP EDITION</div>
                      <h3 className="text-3xl font-black text-white mb-2">RSI(6) + CCI(14)</h3>
                      <p className="text-gray-400 text-sm mb-8 leading-relaxed">
                        Estrategia avanzada de reversión. Busca zonas de extrema sobrecompra/sobreventa donde ambos osciladores (RSI en 6 periodos y CCI en 14 periodos) confirman el agotamiento del precio.
                      </p>
                      
                      <div className="space-y-4 mb-8">
                        <div className="flex items-center gap-3 text-sm font-bold bg-white/5 p-4 rounded-2xl">
                          <div className="w-2 h-2 rounded-full bg-green-500" /> 
                          <span className="text-gray-300">COMPRA: RSI &lt; 20 + CCI &lt; -150</span>
                        </div>
                        <div className="flex items-center gap-3 text-sm font-bold bg-white/5 p-4 rounded-2xl">
                          <div className="w-2 h-2 rounded-full bg-red-500" /> 
                          <span className="text-gray-300">VENTA: RSI &gt; 80 + CCI &gt; 150</span>
                        </div>
                      </div>

                      <div className="bg-[#000814] p-6 rounded-3xl border border-white/5 mb-8">
                        <h4 className="text-[10px] uppercase font-black tracking-[0.3em] text-blue-500 mb-4 flex items-center gap-2">
                          <Settings className="w-4 h-4" /> Parámetros del Ciclo de Prueba
                        </h4>
                        
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                           <div className="space-y-2">
                              <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Cuenta a Utilizar</label>
                              <select 
                                value={backtestConfig.account}
                                onChange={(e) => setBacktestConfig({...backtestConfig, account: e.target.value})}
                                disabled={isTesting}
                                className="w-full bg-black border border-white/10 rounded-xl p-3 text-white focus:border-blue-500 outline-none font-bold text-sm"
                              >
                                <option value="demo">DEMO ACCOUNT</option>
                                <option value="real">REAL ACCOUNT</option>
                              </select>
                           </div>
                           <div className="space-y-2">
                              <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Inversión ($)</label>
                              <input 
                                type="number"
                                min="1"
                                value={backtestConfig.amount}
                                disabled={isTesting}
                                onChange={(e) => setBacktestConfig({...backtestConfig, amount: Number(e.target.value)})}
                                className="w-full bg-black border border-white/10 rounded-xl p-3 text-white focus:border-blue-500 outline-none font-bold text-sm"
                              />
                           </div>
                           <div className="space-y-2">
                              <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Cant. de Entradas</label>
                              <input 
                                type="number"
                                min="1"
                                value={backtestConfig.cycles}
                                disabled={isTesting}
                                onChange={(e) => setBacktestConfig({...backtestConfig, cycles: Number(e.target.value)})}
                                className="w-full bg-black border border-white/10 rounded-xl p-3 text-white focus:border-blue-500 outline-none font-bold text-sm"
                              />
                           </div>
                        </div>

                        <div className="flex items-center justify-between bg-blue-900/20 text-blue-400 text-xs p-3 rounded-xl font-medium border border-blue-500/20 mb-4">
                          <div className="flex gap-3 items-center">
                            <Shield className="w-4 h-4 shrink-0" />
                            <span><b>Escáner Global:</b> Incluye FR 40, GER 30, Crypto, HK 33, US 500, Amazon y todo OTC.</span>
                          </div>
                        </div>
                      </div>

                      <button 
                        onClick={runBacktest}
                        disabled={isTesting}
                        className={`w-full py-5 rounded-2xl font-black text-lg transition-all flex items-center justify-center gap-3 uppercase tracking-wider ${
                          isTesting 
                          ? 'bg-blue-900/50 text-blue-300 cursor-not-allowed shadow-none' 
                          : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-[0_0_20px_rgba(0,100,255,0.4)] hover:scale-[1.02]'
                        }`}
                      >
                        {isTesting ? <RefreshCw className="w-6 h-6 animate-spin" /> : <Play className="w-6 h-6" />}
                        {isTesting ? 'EJECUTANDO ANÁLISIS...' : 'INICIAR CAZA DE MERCADOS'}
                      </button>
                    </div>
                  </div>

                  {/* Oportunidades Cercanas */}
                  <div className="bg-[#0d121f] rounded-[40px] border border-white/5 p-8 flex flex-col min-h-[400px]">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-2xl font-black text-white italic tracking-tighter uppercase">Oportunidades Cercanas</h3>
                        {nearMisses.length > 0 && (
                          <div className="flex items-center gap-3">
                            <span className="bg-blue-500/20 text-blue-400 text-[9px] font-black px-3 py-1 rounded-full border border-blue-500/30 uppercase tracking-widest">
                              {nearMisses.length} señales
                            </span>
                            <button 
                              onClick={() => { setNearMisses([]); localStorage.removeItem('near_misses'); }}
                              className="text-[9px] font-black text-red-500 hover:text-red-400 border border-red-500/30 px-3 py-1.5 rounded-xl uppercase tracking-widest transition-all"
                            >Limpiar</button>
                          </div>
                        )}
                      </div>
                      <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-6">Activos que casi cumplen la estrategia RSI+CCI</p>
                      <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar pr-2 font-sans">
                        {nearMisses.length === 0 ? (
                           <div className="h-full flex flex-col items-center justify-center opacity-20 py-16">
                              <Activity className="w-12 h-12 mb-4 animate-pulse" />
                              <span className="text-[10px] uppercase font-black tracking-widest">Esperando escaneo activo...</span>
                           </div>
                        ) : (
                          nearMisses.map((miss, idx) => (
                            <div key={idx} className={`p-4 rounded-3xl border flex justify-between items-center transition-all ${
                              miss.side === 'CALL' 
                                ? 'bg-green-500/5 border-green-500/20 hover:border-green-500/40' 
                                : 'bg-red-500/5 border-red-500/20 hover:border-red-500/40'
                            }`}>
                               <div className="flex items-center gap-4">
                                  <div className={`w-1.5 h-10 rounded-full shadow-lg ${miss.side === 'CALL' ? 'bg-green-500 shadow-green-500/30' : 'bg-red-500 shadow-red-500/30'}`} />
                                  <div>
                                     <div className="text-xs font-black text-white uppercase tracking-tight">{miss.asset}</div>
                                     <div className="text-[9px] text-gray-500 font-bold mt-1 uppercase">RSI: {miss.rsi} | CCI: {miss.cci}</div>
                                     <div className="text-[8px] text-gray-600 font-bold mt-0.5">{miss.reason}</div>
                                  </div>
                               </div>
                               <div className="text-right">
                                  <div className={`text-[11px] font-black uppercase px-3 py-1 rounded-lg ${miss.side === 'CALL' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                                     {miss.side === 'CALL' ? '↑ POSIBLE COMPRA' : '↓ POSIBLE VENTA'}
                                  </div>
                               </div>
                            </div>
                          ))
                        )}
                      </div>
                  </div>
                </div>

                 {/* Panel de Resultados / Radar / Entradas en Curso */}
                  <div className="space-y-8">
                     {!testResults && !isTesting && (
                       <div className="bg-[#0d121f] rounded-[40px] border border-white/5 p-8 flex flex-col justify-center min-h-[400px]">
                         <div className="text-center text-gray-600 font-bold tracking-widest flex flex-col items-center">
                           <Activity className="w-16 h-16 mb-6 opacity-20" />
                           <span className="uppercase text-sm">Motor Preparado.</span>
                           <span className="text-[10px] mt-2 max-w-[200px] leading-relaxed opacity-60">Configura los parámetros y comienza el ciclo de prueba de 10 operaciones.</span>
                         </div>
                       </div>
                     )}

                     {isTesting && (
                       <>
                         {/* CARD 1: RADAR ESTRATÉGICO */}
                         <div className="bg-[#0d121f] rounded-[40px] border border-white/5 p-8 flex flex-col min-h-[300px]">
                           <div className="text-center mb-6">
                              <div className="inline-flex items-center gap-2 bg-blue-500/10 text-blue-400 px-4 py-2 rounded-full border border-blue-500/20 text-[10px] font-black uppercase tracking-widest mb-4">
                                 <Cpu className="w-3 h-3 animate-spin" /> MODO HUNTER EN LINEA
                              </div>
                              <h3 className="text-2xl font-black text-white italic">RADAR ESTRATÉGICO</h3>
                           </div>

                           <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar max-h-[300px]">
                              {scanTelemetry.length === 0 ? (
                                <div className="text-center py-20 text-gray-600 font-bold uppercase text-xs animate-pulse">Iniciando scanner...</div>
                              ) : (
                                scanTelemetry.map((item, idx) => {
                                  const total = item.progress || 0;
                                  const isReady = Number(total) >= 95;
                                  const rsiVal = Number(item.rsi);
                                  const cciVal = Number(item.cci);
                                  const isScanning = item.rsi === '--'; 
                                  const direction = rsiVal >= 90 ? 'VENTA 🔴' : rsiVal <= 10 ? 'COMPRA 🟢' : '';

                                  return (
                                    <div key={idx} className={`bg-[#080b13] p-4 rounded-2xl border transition-all ${isReady ? 'border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.3)] scale-[1.02]' : 'border-white/5'}`}>
                                       <div className="flex justify-between items-center mb-2">
                                          <span className="text-xs font-black text-white tracking-tighter truncate w-36">{item.asset}</span>
                                          <span className={`text-[10px] font-black ${isReady ? 'text-blue-500 animate-pulse' : isScanning ? 'text-gray-700' : 'text-gray-500'}`}>
                                            {isScanning ? '⏳ ESPERANDO' : direction || `${total}%`}
                                          </span>
                                       </div>
                                       <div className="w-full bg-white/5 h-1.5 rounded-full overflow-hidden">
                                          <div
                                            className={`h-full transition-all duration-700 ${isReady ? 'bg-blue-500 animate-pulse' : isScanning ? 'bg-white/10' : 'bg-gradient-to-r from-blue-900 to-blue-600'}`}
                                            style={{ width: isScanning ? '5%' : `${total}%` }}
                                          />
                                       </div>
                                       <div className="flex justify-between mt-2">
                                          <span className="text-[8px] font-bold text-gray-600 uppercase">RSI: {item.rsi}</span>
                                          <span className="text-[8px] font-bold text-gray-600 uppercase">CCI: {item.cci}</span>
                                       </div>
                                    </div>
                                  );
                                })
                              )}
                           </div>

                           <div className="mt-6 pt-6 border-t border-white/5">
                              <div className="bg-blue-600/10 border border-blue-500/20 p-4 rounded-2xl text-center">
                                 <p className="text-[10px] font-bold text-blue-400 uppercase mb-1">FASE ACTUAL</p>
                                 <p className="text-xs text-blue-200 font-medium">{backtestPhase}</p>
                              </div>
                           </div>
                         </div>

                         {/* CARD 2: OPERACIONES EN CURSO */}
                         <div className="bg-[#0d121f] rounded-[40px] border border-white/5 p-8 flex flex-col min-h-[300px]">
                           <div className="text-center mb-6">
                              <h3 className="text-2xl font-black text-white italic uppercase">Operaciones en Curso</h3>
                              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mt-1">Detalle de entradas del ciclo activo</p>
                           </div>

                           <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar max-h-[300px] font-sans">
                              {!testResults?.report || testResults.report.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center opacity-20 py-16">
                                   <Activity className="w-12 h-12 mb-4 animate-pulse text-blue-500" />
                                   <span className="text-[10px] uppercase font-black tracking-widest text-gray-500">Esperando entradas del bot...</span>
                                </div>
                              ) : (
                                testResults.report.map((t, idx) => (
                                  <div key={idx} className="bg-white/5 p-4 rounded-3xl border border-white/5 flex justify-between items-center animate-in slide-in-from-bottom-2">
                                     <div className="flex items-center gap-4">
                                        <div className={`w-1.5 h-8 rounded-full ${t.side === 'CALL' ? 'bg-green-500' : 'bg-red-500'}`} />
                                        <div>
                                           <div className="text-xs font-black text-white uppercase tracking-tight flex items-center gap-2">
                                             {t.asset}
                                             <span className={`text-[9px] px-2 py-0.5 rounded-full font-black ${t.side === 'CALL' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                                               {t.side}
                                             </span>
                                           </div>
                                           <div className="text-[9px] text-gray-500 font-bold mt-1 uppercase">Entrada: {t.entry} | RSI: {t.rsi} | CCI: {t.cci}</div>
                                        </div>
                                     </div>
                                     <div className="text-right">
                                        <span className={`text-xs font-black ${t.color || (t.result?.includes('GANADA') ? 'text-green-400' : t.result?.includes('PERDIDA') ? 'text-red-400' : 'text-yellow-400 animate-pulse')}`}>
                                           {t.result}
                                        </span>
                                        <div className="text-[8px] text-gray-600 font-black mt-1 uppercase">{t.time}</div>
                                     </div>
                                  </div>
                                ))
                              )}
                           </div>
                         </div>
                       </>
                     )}

                     {testResults && !isTesting && (testResults.accountUsed || testResults.wins !== undefined) && (
                       <div className="bg-[#0d121f] rounded-[40px] border border-white/5 p-8 flex flex-col">
                         <div className="space-y-8 animate-in slide-in-from-bottom-5">
                            <div className="text-center border-b border-white/5 pb-6">
                               <h3 className="text-[10px] tracking-[0.3em] font-black text-gray-500 uppercase mb-2">Resultados del Ciclo</h3>
                               <div className="text-white text-2xl font-black italic tracking-tighter">PERFIL: CUENTA {testResults.accountUsed || backtestConfig.account.toUpperCase()}</div>
                               <div className="text-blue-500 font-bold text-sm mt-1">Inversión por entrada: ${(testResults.amountUsed ?? backtestConfig.amount).toFixed(2)}</div>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4">
                              <div className="bg-[#080b13] p-6 rounded-3xl border border-white/5 text-center shadow-inner">
                                 <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-2">Tasa de Acierto</div>
                                 <div className={`text-4xl font-black drop-shadow-md ${
                                   (testResults.winRate ?? (testResults.total > 0 ? (testResults.wins / testResults.total * 100) : 0)) >= 50 
                                   ? 'text-green-400' : 'text-red-400'
                                 }`}>
                                   {testResults.winRate ?? (testResults.total > 0 ? ((testResults.wins / testResults.total) * 100).toFixed(1) : '0.0')}%
                                 </div>
                              </div>
                              <div className="bg-[#080b13] p-6 rounded-3xl border border-white/5 text-center shadow-inner">
                                 <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-2">Neto (Beneficio)</div>
                                 <div className={`text-3xl font-black mt-1 ${
                                   testResults.isPositive !== undefined 
                                     ? (testResults.isPositive ? 'text-green-500' : 'text-red-500')
                                     : (typeof testResults.profit === 'number' ? (testResults.profit >= 0 ? 'text-green-500' : 'text-red-500') : 'text-gray-400')
                                 }`}>
                                   {typeof testResults.profit === 'string' ? testResults.profit : (typeof testResults.profit === 'number' ? (testResults.profit >= 0 ? `+ $${testResults.profit.toFixed(2)}` : `- $${Math.abs(testResults.profit).toFixed(2)}`) : '--')}
                                 </div>
                              </div>
                            </div>

                            <div className="bg-[#080b13] p-6 rounded-3xl border border-white/5">
                               <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-4 text-center">Desglose de Efectividad</div>
                               <div className="flex justify-between items-center bg-white/5 px-6 py-4 rounded-2xl font-mono text-sm shadow-inner mb-4">
                                 <span className="text-gray-400">Total Operaciones: <b className="text-white">{testResults.trades ?? testResults.total ?? 0}</b></span>
                                 <div className="flex gap-4">
                                   <span className="text-green-400 font-black flex items-center gap-1"><CheckCircle2 className="w-4 h-4"/> G: {testResults.wins ?? 0}</span>
                                   <span className="text-red-400 font-black flex items-center gap-1"><AlertCircle className="w-4 h-4"/> P: {testResults.losses ?? 0}</span>
                                 </div>
                               </div>

                               <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-3 text-center">Operaciones del Ciclo</div>
                               <div className="space-y-2 max-h-[250px] overflow-y-auto pr-2 custom-scrollbar font-sans">
                                 {testResults.report && testResults.report.length > 0 ? (
                                   testResults.report.map((t, idx) => (
                                     <div key={idx} className="bg-white/5 p-3 rounded-2xl border border-white/5 flex justify-between items-center">
                                        <div className="flex items-center gap-3">
                                           <div className={`w-1 h-6 rounded-full ${t.side === 'CALL' ? 'bg-green-500' : 'bg-red-500'}`} />
                                           <div>
                                              <div className="text-[10px] font-black text-white uppercase">{t.asset}</div>
                                              <div className="text-[8px] text-gray-500 font-bold">Entrada: {t.entry} | {t.time}</div>
                                           </div>
                                        </div>
                                        <span className={`text-[10px] font-black ${t.color || (t.result?.includes('GANADA') ? 'text-green-400' : 'text-red-400')}`}>
                                           {t.result}
                                        </span>
                                     </div>
                                   ))
                                 ) : (
                                   <div className="text-[9px] text-gray-600 font-bold uppercase text-center py-2">Sin operaciones registradas</div>
                                 )}
                               </div>
                            </div>
                         </div>
                       </div>
                     )}
                  </div>
               </div>


            </div>
          )}

          {activeTab === 'ajustes' && (
            <div className="max-w-2xl mx-auto space-y-12 py-10">
               <div>
                  <h2 className="text-6xl font-black text-white italic tracking-tighter mb-4 uppercase">Ajustes</h2>
                  <p className="text-gray-500 font-medium">Configuración de enlace seguro y credenciales del Broker.</p>
               </div>

               <div className="space-y-8">
                 <div className="bg-[#0d121f] p-12 rounded-[48px] border border-white/5 space-y-8 shadow-2xl">
                    <div className="space-y-4">
                       <label className="text-[10px] font-black tracking-[0.3em] text-blue-500 uppercase">Cloud Gateway</label>
                       <div className="flex gap-4">
                          <input 
                            ref={gatewayInputRef}
                            defaultValue={gatewayUrl}
                            placeholder="https://su-tunel.trycloudflare.com"
                            className="flex-1 bg-black border border-white/5 rounded-2xl p-5 text-white focus:border-blue-500 outline-none font-bold placeholder:text-gray-800"
                          />
                          <button 
                            onClick={updateGateway}
                            className="bg-blue-600 hover:bg-blue-500 text-white font-black px-10 rounded-2xl transition-all shadow-lg active:scale-95 uppercase text-xs"
                          >
                            Enlazar
                          </button>
                       </div>
                    </div>

                    <form onSubmit={handleBrokerConnect} className="space-y-6 pt-10 border-t border-white/5">
                        <div className="space-y-3">
                           <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.3em]">Broker Account</label>
                           <input 
                             ref={iqEmailRef}
                             defaultValue={localStorage.getItem('iq_email') || ''}
                             placeholder="Email IQ"
                             className="w-full bg-black border border-white/5 rounded-2xl p-5 text-white focus:border-blue-500 outline-none font-bold"
                           />
                           <input 
                             ref={iqPassRef}
                             type="password"
                             defaultValue={localStorage.getItem('iq_pass') || ''}
                             placeholder="Password IQ"
                             className="w-full bg-black border border-white/5 rounded-2xl p-5 text-white focus:border-blue-500 outline-none font-bold"
                           />
                        </div>
                        <button 
                          disabled={isLinking || socketStatus === 'offline' || brokerConnected}
                          className={`w-full py-6 rounded-3xl font-black text-xl transition-all ${
                            (isLinking || socketStatus === 'offline' || brokerConnected)
                            ? 'bg-gray-800 text-gray-500 cursor-not-allowed' 
                            : 'bg-green-600 hover:bg-green-500 text-white shadow-xl active:scale-95'
                          }`}
                        >
                          {isLinking ? 'SINCRONIZANDO...' : brokerConnected ? 'BROKER VINCULADO ✅' : 'VINCULAR CLOUD BROKER'}
                        </button>
                    </form>
                 </div>
               </div>
            </div>
          )}
        </div>
      </main>

      {/* MODAL DE REPORTE FINAL DE CICLO */}
      {cycleReport && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xl z-[100] flex items-center justify-center p-4 overflow-y-auto">
           <div className="w-full max-w-2xl bg-[#0d121f] border border-blue-500/30 rounded-[40px] shadow-[0_0_100px_rgba(37,99,235,0.2)] p-10 animate-in zoom-in duration-300">
              <div className="flex justify-between items-center mb-10 border-b border-white/5 pb-6">
                 <div>
                    <h3 className="text-3xl font-black text-white italic tracking-tighter uppercase">Análisis de Operaciones</h3>
                    <p className="text-[10px] text-blue-400 font-bold uppercase tracking-widest mt-1">Resultados de tu última caza estratégica</p>
                 </div>
                 <button 
                   onClick={() => setCycleReport(null)}
                   className="p-3 bg-white/5 hover:bg-white/10 rounded-full transition-all text-gray-500 hover:text-white"
                 >
                    <LogOut className="w-6 h-6" />
                 </button>
              </div>

              <div className="space-y-4 mb-10 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                 {cycleReport.map((t, idx) => (
                   <div key={idx} className="bg-white/5 border border-white/5 p-6 rounded-3xl flex items-center gap-6">
                      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black ${t.side === 'CALL' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                         {t.side === 'CALL' ? '↑' : '↓'}
                      </div>
                      <div className="flex-1">
                         <div className="text-white font-black text-lg uppercase tracking-tight flex items-center gap-3">
                            {t.asset}
                            <span className={`text-[9px] px-2 py-0.5 rounded-md bg-white/5 ${t.color}`}>{t.result}</span>
                         </div>
                         <div className="text-[10px] text-gray-500 font-bold uppercase mt-1">CONTEXTO: RSI {t.rsi} | CCI {t.cci}</div>
                      </div>
                      <div className="text-right">
                         <div className="text-white font-black text-sm">$ {t.entry}</div>
                         <div className="text-[8px] text-blue-500 font-black uppercase mt-1">Operación {idx + 1}</div>
                      </div>
                   </div>
                 ))}
              </div>

              <div className="grid grid-cols-2 gap-4 mb-10">
                 <div className="bg-white/5 p-6 rounded-3xl border border-white/5 text-center">
                    <div className="text-[10px] text-gray-500 font-bold uppercase mb-2">Efectividad Bruta</div>
                    <div className="text-3xl font-black text-white">{testResults ? ((testResults.wins / testResults.trades) * 100).toFixed(0) : 0}%</div>
                 </div>
                 <div className="bg-white/5 p-6 rounded-3xl border border-white/5 text-center">
                    <div className="text-[10px] text-gray-500 font-bold uppercase mb-2">Balance Neto Est.</div>
                    <div className={`text-3xl font-black ${testResults && testResults.isPositive ? 'text-green-500' : 'text-red-500'}`}>
                       {testResults ? testResults.profit : '$0.00'}
                    </div>
                 </div>
              </div>

              <button 
                onClick={() => setCycleReport(null)}
                className="w-full py-5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-black rounded-2xl hover:scale-[1.02] transition-all uppercase tracking-widest shadow-xl shadow-blue-500/20"
              >
                 Cerrar y Continuar Aprendiendo
              </button>
           </div>
        </div>
      )}
    </div>
  );
};

export default App;
