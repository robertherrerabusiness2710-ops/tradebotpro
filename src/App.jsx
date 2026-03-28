import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, 
  Square, 
  Activity, 
  BarChart2, 
  Settings, 
  TrendingUp, 
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Zap,
  DollarSign,
  Wallet,
  Globe,
  LogIn,
  LogOut,
  User,
  ShieldCheck,
  Mail,
  Lock,
  UserPlus,
  Eye,
  EyeOff,
  History,
  TrendingDown,
  Database,
  Search,
  Server
} from 'lucide-react';
import { io } from 'socket.io-client';
import { 
  auth, 
  db, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword 
} from './lib/firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, setDoc, getDoc, collection, addDoc, serverTimestamp } from 'firebase/firestore';

const App = () => {
  // CONFIGURACIONES BASICAS
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState('login'); 
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showIqPass, setShowIqPass] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  
  const [activeTab, setActiveTab] = useState('dashboard');
  const [balances, setBalances] = useState({ demo: '0.00', real: '0.00' });
  const [livePrice, setLivePrice] = useState({ pair: 'EUR/USD', price: '1.08542', timestamp: '--' });
  const [iqConnected, setIqConnected] = useState(false);
  const [logs, setLogs] = useState([]);
  const [isLinking, setIsLinking] = useState(false);
  
  // OPCIONES DE GATEWAY
  const [gatewayUrl, setGatewayUrl] = useState(localStorage.getItem('tradebot_gateway') || 'https://robert2710-robert-tradebot.hf.space');
  const [backtestResult, setBacktestResult] = useState({ pair: '', rate: 0, signals: 0 });
  const [isBacktesting, setIsBacktesting] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState('EURUSD-OTC');

  // REFS PARA EVITAR PANTALLA BLANCA (BLINDAJE TOTAL)
  const socketRef = useRef(null);
  const iqEmailRef = useRef(null);
  const iqPassRef = useRef(null);
  const gatewayInputRef = useRef(null);

  const addLog = async (msg) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ time, msg: String(msg) }, ...prev].slice(0, 15));
    if (user) {
        try {
            await addDoc(collection(db, `users/${user.uid}/logs`), { msg: String(msg), time: serverTimestamp() });
        } catch (e) { console.error("Log error", e); }
    }
  };

  const loadUserConfig = async (currentUser) => {
    if (!currentUser || !socketRef.current?.connected) return;
    try {
        const docSnap = await getDoc(doc(db, "users", currentUser.uid));
        if (docSnap.exists()) {
            const config = docSnap.data();
            if (config.iqEmail && config.iqPassword) {
                addLog("⏳ Re-vinculando Broker...");
                setIsLinking(true);
                socketRef.current.emit('connect_iq', { 
                    uid: currentUser.uid, 
                    email: config.iqEmail, 
                    password: config.iqPassword, 
                    mode: 'PRACTICE' 
                });
            }
        }
    } catch (e) { console.error("Config error:", e); }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (u) {
        setUser(u);
        addLog(`Usuario ${u.email} activo.`);
        if (socketRef.current?.connected) loadUserConfig(u);
      } else {
        setUser(null);
      }
    });

    // CONEXION AL GATEWAY
    const cleanUrl = gatewayUrl.replace(/\/$/, "");
    if (socketRef.current) socketRef.current.disconnect();

    socketRef.current = io(cleanUrl, {
        reconnection: true,
        reconnectionAttempts: 10,
        transports: ['websocket', 'polling'],
        timeout: 10000
    });

    socketRef.current.on('connect', () => {
        addLog(`📶 Enlace Activo: ${cleanUrl}`);
        if (auth.currentUser) {
            socketRef.current.emit('auth_link', auth.currentUser.uid);
            loadUserConfig(auth.currentUser);
        }
    });

    socketRef.current.on('connect_error', () => {
        addLog(`⚠️ Esperando a la nube... (Sin conexión)`);
    });

    socketRef.current.on('price_update', (data) => setLivePrice(data));
    socketRef.current.on('balance_sync', (data) => setBalances(data));
    socketRef.current.on('iq_connected', (profile) => {
      setIqConnected(true);
      setIsLinking(false);
      addLog(`✅ Broker conectado como: ${profile.name}`);
    });
    
    socketRef.current.on('iq_error', (data) => {
      setIsLinking(false);
      addLog(`❌ Error IQ: ${data.msg}`);
    });

    socketRef.current.on('backtest_result', (data) => {
        setIsBacktesting(false);
        setBacktestResult({ pair: data.pair, rate: data.rate, signals: data.totalSignals });
        addLog(`🧪 Backtest Finalizado: ${data.pair} -> ${data.rate}%`);
    });

    socketRef.current.on('signal', (data) => {
        addLog(`🔥 SEÑAL: ${data.type} en ${data.pair}`);
    });

    return () => {
      unsubscribe();
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, [gatewayUrl]);

  const runBacktest = (e) => {
      if(e) e.preventDefault();
      if (!user || !socketRef.current?.connected) {
          addLog("❌ Error: Gateway no conectado");
          return;
      }
      setIsBacktesting(true);
      addLog(`🔎 Escaneando ${selectedAsset}...`);
      socketRef.current.emit('run_backtest', { uid: user.uid, pair: selectedAsset });
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      if (authMode === 'login') await signInWithEmailAndPassword(auth, email, password);
      else await createUserWithEmailAndPassword(auth, email, password);
    } catch (err) { addLog("❌ Error en autenticación"); } finally { setIsLoading(false); }
  };

  const updateGateway = (e) => {
      if(e) e.preventDefault();
      const url = gatewayInputRef.current?.value;
      if(!url) return;
      localStorage.setItem('tradebot_gateway', url);
      setGatewayUrl(url);
      addLog(`🔄 Gateway -> ${url}`);
      window.location.reload(); 
  };

  const handleIqLink = async (e) => {
    // PROTECCION TOTAL ANTI-CRASH
    if(e) e.preventDefault();
    const iqEmail = iqEmailRef.current?.value;
    const iqPass = iqPassRef.current?.value;
    
    if(!iqEmail || !iqPass) return;
    
    setIsLinking(true);
    addLog("⏳ Vinculando...");
    
    try {
        await setDoc(doc(db, "users", user.uid), { iqEmail, iqPassword: iqPass }, { merge: true });
        if(socketRef.current?.connected) {
            socketRef.current.emit('connect_iq', { uid: user.uid, email: iqEmail, password: iqPass, mode: 'PRACTICE' });
        } else {
            addLog("❌ Error: Socket offline");
            setIsLinking(false);
        }
    } catch (err) { 
        setIsLinking(false); 
        addLog("❌ Error Firestore"); 
    }
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-10 shadow-2xl relative">
            <h1 className="text-3xl font-black text-white mb-8 text-center uppercase tracking-tighter">TradeBot PRO</h1>
            <form onSubmit={handleAuth} className="space-y-4">
               <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-blue-500 font-mono text-sm" />
               <input type={showPassword ? "text" : "password"} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-blue-500 font-mono text-sm" />
               <button type="submit" disabled={isLoading} className="w-full bg-blue-600 font-black py-4 rounded-2xl text-white uppercase text-xs hover:bg-blue-500 transition-all">{isLoading ? 'Cargando...' : 'Entrar'}</button>
            </form>
            <button onClick={() => setAuthMode('register')} className="w-full mt-6 text-slate-500 text-[10px] font-black uppercase text-center">Registrar</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col md:flex-row">
      <aside className="w-full md:w-80 bg-slate-900 border-r border-slate-800 flex flex-col p-8 lg:h-screen lg:sticky lg:top-0">
        <div className="flex items-center gap-3 mb-10">
            <Activity className="w-8 h-8 text-blue-500" />
            <span className="text-xl font-black text-white uppercase tracking-tighter">TradeBot PRO</span>
        </div>
        <nav className="flex-1 space-y-2">
            {['dashboard', 'strategies', 'settings'].map(tab => (
                <button key={tab} type="button" onClick={() => setActiveTab(tab)} className={`w-full flex items-center px-4 py-4 rounded-2xl transition-all font-black text-xs uppercase ${activeTab === tab ? 'bg-blue-600 text-white shadow-xl' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`}>
                  {tab}
                </button>
            ))}
        </nav>
        <button onClick={() => signOut(auth)} className="w-full py-3 bg-rose-600/10 text-rose-500 rounded-xl font-black text-[10px] uppercase">Cerrar Sesión</button>
      </aside>

      <main className="flex-1 p-8 md:p-12 overflow-y-auto overflow-x-hidden">
        <header className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-6">
            <div>
                <h1 className="text-5xl font-black text-white uppercase tracking-tighter mb-2">
                   {activeTab === 'dashboard' ? 'En Vivo' : activeTab === 'strategies' ? 'IA Engine' : 'Ajustes'}
                </h1>
                <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${socketRef.current?.connected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`}></div>
                    <p className="text-slate-500 font-bold uppercase text-[9px] tracking-widest font-mono">Gateway: {socketRef.current?.connected ? 'Linked' : 'Offline'}</p>
                </div>
            </div>
            <div className="flex bg-slate-900 border border-slate-800 rounded-2xl px-6 py-4 divide-x divide-slate-800">
                <div className="pr-6">
                    <span className="block text-[8px] text-slate-500 uppercase font-black">Real</span>
                    <span className="text-emerald-500 font-black font-mono">$ {balances.real}</span>
                </div>
                <div className="pl-6">
                    <span className="block text-[8px] text-slate-500 uppercase font-black">Demo</span>
                    <span className="text-amber-500 font-black font-mono">$ {balances.demo}</span>
                </div>
            </div>
        </header>

        {activeTab === 'dashboard' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 animate-in fade-in duration-500">
              <div className="bg-slate-900 border border-slate-800 p-10 rounded-[2rem] shadow-2xl relative overflow-hidden bg-gradient-to-br from-slate-900 to-slate-950">
                  <span className="inline-flex items-center gap-2 px-3 py-1 bg-blue-500/10 text-blue-500 text-[10px] font-black uppercase rounded-lg border border-blue-500/20 mb-6">Live Price Cloud</span>
                  <h2 className="text-7xl font-black text-white tracking-tighter mb-2 font-mono">{livePrice.price}</h2>
                  <p className="text-slate-500 font-black uppercase text-xs">{livePrice.pair}</p>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-8 rounded-[2rem] shadow-xl flex flex-col bg-gradient-to-b from-slate-900 to-slate-950">
                  <h3 className="text-white font-black text-[10px] uppercase mb-6 tracking-widest">Monitor Cloud</h3>
                  <div className="space-y-4 overflow-y-auto max-h-[400px] flex-1 custom-scrollbar">
                      {logs.map((log, i) => (
                          <div key={i} className="flex gap-4 border-l-2 border-slate-800 pl-4 py-1">
                              <span className="text-slate-600 text-[9px]">{log.time}</span>
                              <span className="text-slate-400 text-[10px]">{log.msg}</span>
                          </div>
                      ))}
                  </div>
              </div>
          </div>
        )}
        
        {activeTab === 'strategies' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-in zoom-in-95 duration-500">
             {[1, 2, 3].map(id => (
                <div key={id} className={`bg-slate-900 border border-slate-800 p-8 rounded-[2rem] shadow-2xl relative overflow-hidden group hover:border-blue-500 transition-all`}>
                   <h3 className="text-2xl font-black text-white mb-2 uppercase tracking-tighter">{id === 1 ? 'Robert RSI+CCI' : id === 2 ? 'EMA Cross' : 'Price Action'}</h3>
                   <div className="grid grid-cols-2 gap-3 mb-8">
                       <div className="bg-slate-950/50 p-4 rounded-3xl text-center">
                          <span className="text-2xl font-mono font-black text-emerald-500">{id === 1 && backtestResult.rate > 0 ? `${backtestResult.rate}%` : '--'}</span>
                          <span className="block text-[8px] text-slate-600 uppercase">WinRate</span>
                       </div>
                       <div className="bg-slate-950/50 p-4 rounded-3xl text-center">
                          <span className="text-2xl font-mono font-black text-blue-500">{id === 1 && backtestResult.signals > 0 ? backtestResult.signals : '--'}</span>
                          <span className="block text-[8px] text-slate-600 uppercase">Signals</span>
                       </div>
                   </div>
                   {id === 1 && (
                       <select 
                        value={selectedAsset} 
                        onChange={(e) => setSelectedAsset(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-5 py-4 text-[10px] font-black text-white outline-none cursor-pointer mb-4"
                       >
                          <option value="EURUSD-OTC">EUR/USD (OTC)</option>
                          <option value="FR40-OTC">FR 40 France (OTC)</option>
                          <option value="FET-OTC">FET Crypto (OTC)</option>
                       </select>
                   )}
                   <button onClick={runBacktest} disabled={isBacktesting || !iqConnected} className="w-full py-4 bg-slate-800 text-white rounded-2xl text-[11px] font-black uppercase mb-4 active:scale-95 disabled:opacity-20">{isBacktesting ? 'Corriendo...' : 'Backtest'}</button>
                   <button className="w-full py-5 bg-blue-600 text-white rounded-[1.5rem] text-[12px] font-black uppercase active:scale-95 shadow-xl">Launch Real</button>
                </div>
             ))}
          </div>
        )}
        
        {activeTab === 'settings' && (
          <div className="max-w-xl animate-in fade-in slide-in-from-right-10 duration-500">
             <div className="bg-slate-900 border border-slate-800 rounded-[2rem] p-10 shadow-2xl relative overflow-hidden">
                <h2 className="text-3xl font-black text-white mb-8 uppercase tracking-tighter">Ajustes Cloud</h2>
                <div className="space-y-6">
                   <div className="p-6 bg-slate-950/50 border border-blue-500/20 rounded-3xl">
                       <label className="block text-[10px] font-black text-blue-500 uppercase tracking-widest mb-4">Cloud Gateway</label>
                       <div className="flex gap-3">
                          <input type="text" ref={gatewayInputRef} defaultValue={gatewayUrl} className="flex-1 bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-mono text-xs" />
                          <button onClick={updateGateway} className="px-6 bg-blue-600 text-white rounded-2xl font-black text-[10px] uppercase">Enlazar</button>
                       </div>
                   </div>
                   <div className="space-y-4">
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">IQ Account</label>
                       <input type="email" ref={iqEmailRef} placeholder="Email IQ" className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-mono text-sm" />
                       <input type={showIqPass ? "text" : "password"} ref={iqPassRef} placeholder="Password IQ" className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white font-mono text-sm" />
                       <button onClick={handleIqLink} disabled={isLinking} className="w-full bg-emerald-600 font-black py-5 rounded-2xl text-white uppercase text-xs active:scale-95 shadow-xl disabled:opacity-30">{isLinking ? 'Sincronizando...' : 'Vincular Cloud Broker'}</button>
                   </div>
                </div>
             </div>
          </div>
        )}
      </main>
      
      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 10px; }
      `}} />
    </div>
  );
};

export default App;
