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
  provider, 
  signInWithPopup, 
  db, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword 
} from './lib/firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, setDoc, getDoc, collection, addDoc, serverTimestamp, onSnapshot, query, orderBy, limit } from 'firebase/firestore';

const App = () => {
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState('login'); 
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showIqPass, setShowIqPass] = useState(false);
  const [errorStatus, setErrorStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  
  const [activeTab, setActiveTab] = useState('dashboard');
  const [balances, setBalances] = useState({ demo: '0.00', real: '0.00' });
  const [livePrice, setLivePrice] = useState({ pair: 'EUR/USD', price: '1.08542', timestamp: '--' });
  const [iqConnected, setIqConnected] = useState(false);
  const [iqProfile, setIqProfile] = useState(null);
  const [logs, setLogs] = useState([]);
  const [isLinking, setIsLinking] = useState(false);
  
  // OPCIONES DE GATEWAY (HUGGING FACE, GLITCH O LOCAL TUNNEL)
  const [gatewayUrl, setGatewayUrl] = useState(localStorage.getItem('tradebot_gateway') || 'https://robert2710-robert-tradebot.hf.space');
  const [backtestResult, setBacktestResult] = useState({ pair: '', rate: 0, signals: 0 });
  const [isBacktesting, setIsBacktesting] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState('EURUSD-OTC');

  const socketRef = useRef(null);
  const [strategies, setStrategies] = useState([
    { id: 1, name: 'Robert Herrera (RSI 6 + CCI 14)', isActive: false, winRate: 0 },
    { id: 2, name: 'EMA Cross Pro', isActive: false, winRate: 0 },
    { id: 3, name: 'Price Action Reversal', isActive: false, winRate: 0 }
  ]);

  const addLog = async (msg) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ time, msg }, ...prev].slice(0, 15));
    if (user) {
        try {
            await addDoc(collection(db, `users/${user.uid}/logs`), { msg, time: serverTimestamp() });
        } catch (e) { console.error("Firebase log error", e); }
    }
  };

  const loadUserConfig = async (currentUser) => {
    if (!currentUser || !socketRef.current?.connected) return;
    try {
        const docRef = doc(db, "users", currentUser.uid);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const config = docSnap.data();
            if (config.iqEmail && config.iqPassword) {
                addLog("⏳ Re-vinculando Broker desde la nube...");
                setIsLinking(true);
                socketRef.current.emit('connect_iq', { 
                    uid: currentUser.uid, 
                    email: config.iqEmail, 
                    password: config.iqPassword, 
                    mode: 'PRACTICE' 
                });
            }
        }
    } catch (e) { console.error("Error cargando config:", e); }
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

    // CONEXION AL GATEWAY CLOUD O LOCAL (Dinamico)
    const cleanUrl = gatewayUrl.replace(/\/$/, ""); // Quitar slash final si existe
    socketRef.current = io(cleanUrl, {
        reconnection: true,
        reconnectionAttempts: 20,
        transports: ['websocket', 'polling'],
        timeout: 15000
    });

    socketRef.current.on('connect', () => {
        addLog(`📶 Gateway Linkeado: ${cleanUrl}`);
        if (auth.currentUser) {
            socketRef.current.emit('auth_link', auth.currentUser.uid);
            loadUserConfig(auth.currentUser);
        }
    });

    socketRef.current.on('connect_error', (err) => {
        addLog(`⚠️ Esperando a la nube... (Protocolo en pausa)`);
    });

    socketRef.current.on('price_update', (data) => setLivePrice(data));
    socketRef.current.on('balance_sync', (data) => setBalances(data));
    socketRef.current.on('iq_connected', (profile) => {
      setIqConnected(true);
      setIqProfile(profile);
      setIsLinking(false);
      addLog(`✅ Broker conectado como: ${profile.name}`);
    });
    
    socketRef.current.on('iq_error', (data) => {
      setIsLinking(false);
      addLog(`❌ Error en IQ: ${data.msg}`);
    });

    socketRef.current.on('backtest_result', (data) => {
        setIsBacktesting(false);
        setBacktestResult({ pair: data.pair, rate: data.rate, signals: data.totalSignals });
        addLog(`🧪 Backtest Finalizado: ${data.pair} -> ${data.rate}% (${data.totalSignals} señales)`);
    });

    socketRef.current.on('signal', (data) => {
        addLog(`🔥 SEÑAL DETECTADA: ${data.type} en ${data.pair} (RSI: ${data.rsi?.toFixed(1) || '?'}, CCI: ${data.cci?.toFixed(1) || '?'})`);
    });

    return () => {
      unsubscribe();
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, [gatewayUrl]);

  const runBacktest = (e) => {
      if(e && e.preventDefault) e.preventDefault(); // SUPER-BLOQUEO DE RECARGA
      if (!user || !socketRef.current?.connected) {
          addLog("❌ Error: No hay enlace con el Gateway");
          return;
      }
      setIsBacktesting(true);
      addLog(`🔎 Analizando OTC en ${selectedAsset}...`);
      socketRef.current.emit('run_backtest', { uid: user.uid, pair: selectedAsset });
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorStatus('');
    try {
      if (authMode === 'login') await signInWithEmailAndPassword(auth, email, password);
      else await createUserWithEmailAndPassword(auth, email, password);
    } catch (err) { setErrorStatus("Error en autenticación"); } finally { setIsLoading(false); }
  };

  const logout = async () => {
    await signOut(auth);
    setIqConnected(false);
    setUser(null);
  };

  const updateGateway = (e) => {
      if(e && e.preventDefault) e.preventDefault();
      const url = document.getElementById('gateway_url').value;
      if(!url) return;
      localStorage.setItem('tradebot_gateway', url);
      setGatewayUrl(url);
      addLog(`🔄 Cambio de Gateway a: ${url}`);
      window.location.reload(); 
  };

  const handleIqLink = async (e) => {
    // BLINDAJE TOTAL ANTI-PANTALLA BLANCA
    if(e && e.preventDefault) e.preventDefault();
    if(e && e.stopPropagation) e.stopPropagation();
    
    const iqEmail = document.getElementById('iq_email_input').value;
    const iqPass = document.getElementById('iq_pass_input').value;
    
    if(!iqEmail || !iqPass) {
        addLog("❌ Error: Faltan credenciales");
        return;
    }
    
    setIsLinking(true);
    addLog("⏳ Vinculando protocolos de seguridad...");
    
    try {
        await setDoc(doc(db, "users", user.uid), { iqEmail, iqPassword: iqPass }, { merge: true });
        if(socketRef.current?.connected) {
            socketRef.current.emit('connect_iq', { uid: user.uid, email: iqEmail, password: iqPass, mode: 'PRACTICE' });
        } else {
            addLog("❌ Error: El Gateway no responde");
            setIsLinking(false);
        }
    } catch (err) { 
        setIsLinking(false); 
        addLog("❌ Error Firebase: No se pudo guardar la clave"); 
    }
    return false; // Evita cualquier accion extra
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-10 shadow-2xl relative">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-600 to-indigo-500"></div>
            <h1 className="text-3xl font-black text-white mb-1 text-center uppercase tracking-tighter">TradeBot PRO</h1>
            <p className="text-slate-500 mb-8 text-center text-xs font-bold uppercase tracking-widest">Global Trading Engine</p>
            <form onSubmit={handleAuth} className="space-y-4">
               <div>
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 ml-1 px-1">Correo Electrónico</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm" />
               </div>
               <div className="relative">
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 ml-1 px-1">Contraseña</label>
                  <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} required className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm" />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-5 bottom-4 text-slate-500 hover:text-white transition-colors">
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
               </div>
               <button type="submit" disabled={isLoading} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black py-4 px-6 rounded-2xl transition-all shadow-lg uppercase tracking-wider text-xs">{isLoading ? 'PROCESANDO...' : 'ENTRAR'}</button>
            </form>
            <button type="button" onClick={() => setAuthMode('register')} className="w-full mt-6 text-slate-500 hover:text-blue-400 text-[10px] font-black transition-colors uppercase tracking-widest text-center">Crear Cuenta</button>
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
                <button key={tab} type="button" onClick={() => setActiveTab(tab)} className={`w-full flex items-center px-4 py-4 rounded-2xl transition-all font-black text-xs uppercase tracking-widest ${activeTab === tab ? 'bg-blue-600 text-white shadow-xl' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`}>
                  <span className="mr-3">{tab === 'dashboard' ? <Activity className="w-5 h-5" /> : tab === 'strategies' ? <BarChart2 className="w-5 h-5" /> : <Settings className="w-5 h-5" />}</span>
                  {tab}
                </button>
            ))}
        </nav>
        <div className="mt-auto border-t border-slate-800 pt-6">
            <div className={`flex items-center gap-4 mb-4 p-4 rounded-2xl ${iqConnected ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-slate-800/50 border border-slate-800'}`}>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black ${iqConnected ? 'bg-emerald-500 text-white' : 'bg-slate-700 text-slate-400'}`}>{user.email[0].toUpperCase()}</div>
                <div>
                    <p className="text-white font-black text-xs uppercase truncate tracking-tighter">{user.email.split('@')[0]}</p>
                    <p className={`text-[9px] font-black uppercase tracking-widest ${iqConnected ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {iqConnected ? 'Broker Online' : 'Broker Offline'}
                    </p>
                </div>
            </div>
            <button type="button" onClick={logout} className="w-full flex items-center justify-center gap-2 py-3 bg-rose-600/10 hover:bg-rose-600 text-rose-500 hover:text-white rounded-xl transition-all font-black text-[10px] uppercase">
                <LogOut className="w-4 h-4" /> Cerrar Sesión
            </button>
        </div>
      </aside>

      <main className="flex-1 p-8 md:p-12 overflow-y-auto overflow-x-hidden">
        <header className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-6">
            <div>
                <h1 className="text-5xl font-black text-white uppercase tracking-tighter mb-2">
                   {activeTab === 'dashboard' ? 'En Vivo' : activeTab === 'strategies' ? 'IA Engine' : 'Ajustes'}
                </h1>
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${socketRef.current?.connected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`}></div>
                        <p className="text-slate-500 font-bold uppercase text-[9px] tracking-widest font-mono">Gateway Status: {socketRef.current?.connected ? 'Linked' : 'Offline'}</p>
                    </div>
                </div>
            </div>
            {activeTab === 'dashboard' && iqConnected && (
                <div className="flex bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden divide-x divide-slate-800">
                    <div className="px-6 py-4 bg-slate-900/50">
                        <span className="block text-[8px] text-slate-500 font-black uppercase tracking-widest mb-1">Portfolio Real</span>
                        <span className="text-emerald-500 font-mono font-black">$ {balances.real}</span>
                    </div>
                    <div className="px-6 py-4 bg-slate-900/50">
                        <span className="block text-[8px] text-slate-500 font-black uppercase tracking-widest mb-1">Cuenta Practica</span>
                        <span className="text-amber-500 font-mono font-black">$ {balances.demo}</span>
                    </div>
                </div>
            )}
        </header>

        {activeTab === 'dashboard' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-500">
              <div className="lg:col-span-2 space-y-6">
                  <div className="bg-slate-900 border border-slate-800 p-10 rounded-[2rem] shadow-2xl relative overflow-hidden group bg-gradient-to-br from-slate-900 to-slate-950">
                      <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform"><TrendingUp className="w-40 h-40" /></div>
                      <div className="relative z-10">
                          <span className="inline-flex items-center gap-2 px-3 py-1 bg-blue-500/10 text-blue-500 text-[10px] font-black uppercase rounded-lg border border-blue-500/20 mb-6">
                            <Zap className="w-3 h-3 animate-pulse" /> Cotización Directa Cloud
                          </span>
                          <h2 className="text-7xl font-black text-white tracking-tighter mb-2 font-mono">{livePrice.price}</h2>
                          <div className="flex items-center gap-4">
                            <p className="text-slate-500 font-black uppercase text-xs tracking-widest flex items-center gap-2">
                                <Globe className="w-5 h-5 text-blue-500" /> {livePrice.pair}
                            </p>
                            <span className="text-slate-800">|</span>
                            <p className="text-[10px] font-mono text-slate-600">{livePrice.timestamp}</p>
                          </div>
                      </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl hover:border-emerald-500/40 transition-all flex flex-col justify-between">
                          <h3 className="text-white font-black text-[10px] uppercase mb-10 tracking-widest flex items-center justify-between">
                             <span>Indices OTC Calientes</span>
                             <TrendingUp className="w-4 h-4 text-emerald-500" />
                          </h3>
                          <div className="space-y-4">
                             {['FR40-OTC', 'EU50-OTC', 'FET-OTC'].map(p => (
                                <div key={p} className="flex items-center justify-between border-b border-slate-800/50 pb-2">
                                    <span className="text-[11px] font-mono text-slate-400">{p}</span>
                                    <span className="text-[11px] font-black text-emerald-500">+1.24%</span>
                                </div>
                             ))}
                          </div>
                      </div>
                      <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl text-center flex flex-col items-center justify-center hover:border-blue-500/40 transition-all">
                          <Database className="w-10 h-10 text-slate-800 mb-4" />
                          <p className="text-[10px] text-slate-600 font-black uppercase tracking-widest">Persistencia Cloud: Activa</p>
                          <p className="text-[9px] text-slate-500 mt-2 font-mono">Resguardo encriptado: Ok</p>
                      </div>
                  </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-8 rounded-[2rem] shadow-xl flex flex-col bg-gradient-to-b from-slate-900 to-slate-950">
                  <h3 className="text-white font-black text-[10px] uppercase mb-6 tracking-widest flex items-center gap-2">
                    <History className="w-4 h-4 text-blue-500" /> Monitor de Operaciones Cloud
                  </h3>
                  <div className="space-y-4 overflow-y-auto max-h-[600px] flex-1 pr-2 custom-scrollbar">
                      {logs.map((log, i) => (
                          <div key={i} className="group flex gap-4 border-l-2 border-slate-800 hover:border-blue-600 pl-4 py-2 transition-all">
                              <div className="flex flex-col">
                                  <span className="text-slate-600 text-[9px] font-bold group-hover:text-blue-500">{log.time}</span>
                                  <span className="text-slate-400 text-[10px] leading-relaxed group-hover:text-slate-200">{log.msg}</span>
                              </div>
                          </div>
                      ))}
                      {logs.length === 0 && <p className="text-slate-700 text-[9px] text-center mt-10 font-bold uppercase tracking-widest animate-pulse">Iniciando protocolos de seguridad...</p>}
                  </div>
              </div>
          </div>
        )}
        
        {activeTab === 'strategies' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-in zoom-in-95 duration-500">
             {strategies.map(st => (
                <div key={st.id} className={`bg-slate-900 border border-slate-800 p-8 rounded-[2rem] shadow-2xl relative overflow-hidden group hover:border-blue-500 transition-all ${st.isActive ? 'ring-2 ring-blue-600' : ''}`}>
                   <h3 className="text-2xl font-black text-white mb-2 uppercase tracking-tighter">{st.name}</h3>
                   <div className="flex items-center gap-2 mb-6 text-blue-500">
                        <Zap className="w-3 h-3" />
                        <span className="text-[9px] font-black uppercase tracking-widest">Motor Reversal v2.1</span>
                   </div>
                   
                   <div className="grid grid-cols-2 gap-3 mb-8">
                       <div className="bg-slate-950/50 p-4 rounded-3xl border border-slate-800 text-center">
                          <span className="block text-[8px] text-slate-600 font-black uppercase mb-1 tracking-widest">Win Rate</span>
                          <span className="text-2xl font-mono font-black text-emerald-500">{st.id === 1 && backtestResult.rate > 0 ? `${backtestResult.rate}%` : '--'}</span>
                       </div>
                       <div className="bg-slate-950/50 p-4 rounded-3xl border border-slate-800 text-center">
                          <span className="block text-[8px] text-slate-600 font-black uppercase mb-1 tracking-widest">Señales</span>
                          <span className="text-2xl font-mono font-black text-blue-500">{st.id === 1 && backtestResult.signals > 0 ? backtestResult.signals : '--'}</span>
                       </div>
                   </div>

                   <div className="space-y-4">
                       {st.id === 1 && (
                           <select 
                            value={selectedAsset} 
                            onChange={(e) => setSelectedAsset(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-5 py-4 text-[10px] font-black text-white outline-none focus:border-blue-500 transition-all cursor-pointer"
                           >
                              <optgroup label="Forex OTC">
                                <option value="EURUSD-OTC">EUR/USD (OTC)</option>
                                <option value="GBPUSD-OTC">GBP/USD (OTC)</option>
                              </optgroup>
                              <optgroup label="Indices OTC">
                                <option value="FR40-OTC">FR 40 France (OTC)</option>
                                <option value="EU50-OTC">EU 50 Stoxx (OTC)</option>
                              </optgroup>
                              <optgroup label="Crypto OTC">
                                <option value="FET-OTC">FET Crypto (OTC)</option>
                                <option value="DYDX-OTC">DYDX Crypto (OTC)</option>
                                <option value="SOL-OTC">SOLANA (OTC)</option>
                              </optgroup>
                           </select>
                       )}
                       
                       <button 
                        type="button"
                        onClick={runBacktest}
                        disabled={isBacktesting || !iqConnected}
                        className="w-full py-4 bg-slate-800 hover:bg-slate-700 text-white rounded-2xl text-[11px] font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all disabled:opacity-30 disabled:cursor-not-allowed group"
                       >
                          {isBacktesting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-5 h-5 group-hover:scale-110 transition-transform" />}
                          Scann & Backtest Robert
                       </button>

                       <button type="button" className={`w-full py-5 rounded-[1.5rem] text-[12px] font-black uppercase tracking-widest flex items-center justify-center gap-3 transition-all ${st.isActive ? 'bg-rose-600 text-white shadow-xl' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-xl'}`}>
                          {st.isActive ? <Square className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
                          {st.isActive ? 'Detener Bot' : 'Lanzar en Real'}
                       </button>
                   </div>
                </div>
             ))}
          </div>
        )}
        
        {activeTab === 'settings' && (
          <div className="max-w-xl animate-in fade-in slide-in-from-right-10 duration-500">
             <div className="bg-slate-900 border border-slate-800 rounded-[2rem] p-10 shadow-2xl relative overflow-hidden bg-gradient-to-br from-slate-900 to-slate-950">
                <div className="absolute top-0 right-0 p-8 opacity-5"><ShieldCheck className="w-40 h-40" /></div>
                <h2 className="text-3xl font-black text-white mb-2 uppercase tracking-tighter">Protocolos Cloud</h2>
                <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest mb-10">Configuración Central de Enlace</p>

                <div className="space-y-6">
                   <div className="p-6 bg-slate-950/50 border border-blue-500/20 rounded-3xl">
                       <label className="block text-[10px] font-black text-blue-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                          <Globe className="w-4 h-4" /> Cloud Gateway (HuggingFace/Glitch/Tunnel)
                       </label>
                       <div className="flex gap-3">
                          <input type="text" id="gateway_url" defaultValue={gatewayUrl} placeholder="https://tu-proyecto.hf.space" className="flex-1 bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-xs" />
                          <button type="button" onClick={updateGateway} className="px-6 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black text-[10px] uppercase shadow-lg">Enlazar</button>
                       </div>
                   </div>

                   <div className="space-y-4">
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Autenticación Broker IQ</label>
                       <div className="relative">
                          <Mail className="absolute left-6 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                          <input type="email" id="iq_email_input" placeholder="correo@ejemplo.com" className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-14 pr-6 py-5 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm" />
                       </div>
                       <div className="relative">
                          <Lock className="absolute left-6 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                          <input type={showIqPass ? "text" : "password"} id="iq_pass_input" placeholder="••••••••" className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-14 pr-12 py-5 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm" />
                          <button type="button" onClick={() => setShowIqPass(!showIqPass)} className="absolute right-6 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors">
                              {showIqPass ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                          </button>
                       </div>
                       <button 
                        type="button" 
                        id="sync_button"
                        onClick={handleIqLink} 
                        disabled={isLinking} 
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black py-5 px-6 rounded-2xl transition-all shadow-xl uppercase tracking-wider text-xs flex items-center justify-center gap-3 active:scale-95"
                       >
                         {isLinking ? <RefreshCw className="w-5 h-5 animate-spin" /> : <ShieldCheck className="w-5 h-5" />}
                         {isLinking ? 'Sincronizando protocolos...' : 'Sincronizar Broker en la Nube'}
                       </button>
                   </div>

                   <div className="mt-8 p-6 bg-slate-950/20 border-l-4 border-amber-500 rounded-r-3xl">
                       <h4 className="text-[10px] font-black text-amber-500 uppercase mb-2">💡 ¿Fallo al conectar?</h4>
                       <p className="text-[10px] text-slate-500 leading-relaxed font-bold">Si IQ Option bloquea la nube (HuggingFace/Render), usa tu propia laptop como servidor ejecutando "npm start" y usa un túnel local como Cloudflared o Ngrok.</p>
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
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #334155; }
      `}} />
    </div>
  );
};

export default App;
