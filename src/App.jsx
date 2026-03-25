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
  TrendingDown
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
  
  // OPCIONES DE OTC Y BACKTEST
  const [backtestResult, setBacktestResult] = useState({ pair: '', rate: 0, signals: 0 });
  const [isBacktesting, setIsBacktesting] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState('EURUSD-OTC');

  const socketRef = useRef(null);
  const [strategies, setStrategies] = useState([
    { id: 1, name: 'RSI(6)+CCI(14) OTC', isActive: false, winRate: 0 },
    { id: 2, name: 'EMA Cross Pro', isActive: false, winRate: 0 },
    { id: 3, name: 'Price Action Reversal', isActive: false, winRate: 0 }
  ]);

  const addLog = async (msg) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ time, msg }, ...prev].slice(0, 10));
    if (user) {
        try {
            await addDoc(collection(db, `users/${user.uid}/logs`), { msg, time: serverTimestamp() });
        } catch (e) { console.error("Firebase log error", e); }
    }
  };

  const loadUserConfig = async (currentUser) => {
    if (!currentUser || !socketRef.current) return;
    try {
        const docRef = doc(db, "users", currentUser.uid);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const config = docSnap.data();
            if (config.iqEmail && config.iqPassword) {
                addLog("⏳ Sincronizando con el Broker desde la nube...");
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

    const GATEWAY_URL = 'https://tradebotpro.onrender.com';
    socketRef.current = io(GATEWAY_URL, {
        reconnection: true,
        reconnectionAttempts: 10,
        transports: ['websocket', 'polling'],
        timeout: 10000
    });

    socketRef.current.on('connect', () => {
        addLog("📶 Sesión Cloud vinculada con éxito.");
        if (auth.currentUser) {
            socketRef.current.emit('auth_link', auth.currentUser.uid);
            loadUserConfig(auth.currentUser);
        }
    });

    socketRef.current.on('price_update', (data) => setLivePrice(data));
    socketRef.current.on('balance_sync', (data) => setBalances(data));
    socketRef.current.on('iq_connected', (profile) => {
      setIqConnected(true);
      setIqProfile(profile);
      setIsLinking(false);
      addLog(`✅ Broker conectado como: ${profile.name}`);
    });

    socketRef.current.on('backtest_result', (data) => {
        setIsBacktesting(false);
        setBacktestResult({ pair: data.pair, rate: data.rate, signals: data.totalSignals });
        addLog(`🧪 Backtest Finalizado: ${data.pair} -> ${data.rate}% (${data.totalSignals} señales)`);
    });

    socketRef.current.on('signal', (data) => {
        addLog(`🔥 SEÑAL DETECTADA: ${data.type} en ${data.pair} (RSI: ${data.rsi.toFixed(1)}, CCI: ${data.cci.toFixed(1)})`);
    });

    return () => {
      unsubscribe();
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  const runBacktest = () => {
      if (!user || !socketRef.current) return;
      setIsBacktesting(true);
      addLog(`🔎 Iniciando Backtest Multi-Activo en ${selectedAsset}...`);
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

  const handleIqLink = async () => {
    const iqEmail = document.getElementById('iq_email').value;
    const iqPass = document.getElementById('iq_pass').value;
    if(!iqEmail || !iqPass) return;
    setIsLinking(true);
    try {
        await setDoc(doc(db, "users", user.uid), { iqEmail, iqPassword: iqPass }, { merge: true });
        socketRef.current.emit('connect_iq', { uid: user.uid, email: iqEmail, password: iqPass, mode: 'PRACTICE' });
    } catch (err) { setIsLinking(false); }
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-10 shadow-2xl relative">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-600 to-indigo-500"></div>
            <h1 className="text-3xl font-black text-white mb-1 text-center uppercase tracking-tighter">TradeBot PRO</h1>
            <p className="text-slate-500 mb-8 text-center text-xs font-bold uppercase tracking-widest">Cloud Trading Center</p>
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
            <button onClick={() => setAuthMode('register')} className="w-full mt-6 text-slate-500 hover:text-blue-400 text-[10px] font-black transition-colors uppercase tracking-widest text-center">Registrar Cuenta Nueva</button>
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
                <button key={tab} onClick={() => setActiveTab(tab)} className={`w-full flex items-center px-4 py-4 rounded-2xl transition-all font-black text-xs uppercase tracking-widest ${activeTab === tab ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.3)]' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`}>
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
            <button onClick={logout} className="w-full flex items-center justify-center gap-2 py-3 bg-rose-600/10 hover:bg-rose-600 text-rose-500 hover:text-white rounded-xl transition-all font-black text-[10px] uppercase">
                <LogOut className="w-4 h-4" /> Cerrar Sesión
            </button>
        </div>
      </aside>

      <main className="flex-1 p-8 md:p-12 overflow-y-auto overflow-x-hidden">
        <header className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-6">
            <div>
                <h1 className="text-5xl font-black text-white uppercase tracking-tighter mb-2">
                   {activeTab === 'dashboard' ? 'Operativo' : activeTab === 'strategies' ? 'Factoría IA' : 'Config'}
                </h1>
                <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${socketRef.current?.connected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`}></div>
                    <p className="text-slate-500 font-bold uppercase text-[9px] tracking-widest font-mono">Gateway Status: {socketRef.current?.connected ? 'Activo' : 'Offline'}</p>
                </div>
            </div>
            {activeTab === 'dashboard' && iqConnected && (
                <div className="flex bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden divide-x divide-slate-800">
                    <div className="px-6 py-3 bg-slate-900/50">
                        <span className="block text-[9px] text-slate-500 font-black uppercase tracking-widest mb-1">Real Portfolio</span>
                        <span className="text-emerald-500 font-mono font-black">$ {balances.real}</span>
                    </div>
                    <div className="px-6 py-3 bg-slate-900/50">
                        <span className="block text-[9px] text-slate-500 font-black uppercase tracking-widest mb-1">Demo Account</span>
                        <span className="text-amber-500 font-mono font-black">$ {balances.demo}</span>
                    </div>
                </div>
            )}
        </header>

        {activeTab === 'dashboard' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="lg:col-span-2 space-y-6">
                  <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-2xl relative overflow-hidden group">
                      <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform"><TrendingUp className="w-40 h-40" /></div>
                      <div className="flex items-start justify-between relative z-10">
                          <div>
                              <span className="inline-flex items-center gap-2 px-3 py-1 bg-blue-500/10 text-blue-500 text-[10px] font-black uppercase rounded-lg border border-blue-500/20 mb-4">
                                <Zap className="w-3 h-3" /> Live Market Feed
                              </span>
                              <h2 className="text-6xl font-black text-white tracking-tighter mb-1 font-mono">{livePrice.price}</h2>
                              <p className="text-slate-500 font-black uppercase text-xs tracking-widest flex items-center gap-2 leading-none">
                                <Globe className="w-4 h-4" /> {livePrice.pair} <span className="text-[10px] opacity-30">|</span> {livePrice.timestamp}
                              </p>
                          </div>
                          <div className="w-48 h-20 bg-slate-950/50 rounded-2xl border border-slate-800/50 p-4">
                             {/* Mini Sparkline mockup */}
                             <div className="flex items-end justify-between h-full gap-1">
                                {[30,45,60,40,70,85,60,90,75,100].map((h, i) => (
                                    <div key={i} className="flex-1 bg-blue-500/20 rounded-t-sm" style={{ height: `${h}%` }}></div>
                                ))}
                             </div>
                          </div>
                      </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="bg-slate-900/50 border border-slate-800 p-6 rounded-2xl hover:border-blue-500/40 transition-colors">
                          <h3 className="text-white font-black text-xs uppercase mb-4 tracking-widest flex items-center gap-2">
                             <TrendingUp className="w-4 h-4 text-emerald-500" /> Top Gainers OTC
                          </h3>
                          <div className="space-y-4">
                             {['FR40-OTC', 'EU50-OTC', 'AUT20-OTC'].map(p => (
                                <div key={p} className="flex items-center justify-between border-b border-slate-800/50 pb-2">
                                    <span className="text-[10px] font-mono text-slate-400">{p}</span>
                                    <span className="text-[10px] font-black text-emerald-500">+1.24%</span>
                                </div>
                             ))}
                          </div>
                      </div>
                      <div className="bg-slate-900/50 border border-slate-800 p-6 rounded-2xl hover:border-rose-500/40 transition-colors">
                          <h3 className="text-white font-black text-xs uppercase mb-4 tracking-widest flex items-center gap-2">
                             <History className="w-4 h-4 text-blue-500" /> Sesiones Activas
                          </h3>
                          <div className="flex flex-col items-center justify-center py-4 text-center">
                             <ShieldCheck className="w-10 h-10 text-slate-800 mb-2" />
                             <p className="text-[9px] text-slate-600 font-black uppercase">Sin ejecuciones pendientes</p>
                          </div>
                      </div>
                  </div>
              </div>

              <div className="space-y-6">
                  <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl h-full shadow-xl">
                      <h3 className="text-white font-black text-xs uppercase mb-6 tracking-widest flex items-center gap-2">
                        <Activity className="w-4 h-4 text-blue-500 animate-pulse" /> Monitor Biométrico Cloud
                      </h3>
                      <div className="space-y-3 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar font-mono text-[10px]">
                          {logs.map((log, i) => (
                              <div key={i} className="group flex flex-col gap-1 border-l-2 border-slate-800 hover:border-blue-500/50 pl-4 py-1 transition-all">
                                  <span className="text-slate-600 text-[9px] font-black group-hover:text-blue-500">{log.time}</span>
                                  <span className="text-slate-400 leading-relaxed">{log.msg}</span>
                              </div>
                          ))}
                      </div>
                  </div>
              </div>
          </div>
        )}
        
        {activeTab === 'strategies' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-in zoom-in-95 duration-500">
             {strategies.map(st => (
                <div key={st.id} className={`bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-xl relative overflow-hidden group hover:border-blue-500/40 transition-all ${st.isActive ? 'ring-2 ring-blue-600' : ''}`}>
                   <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-600 to-emerald-500 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                   <h3 className="text-xl font-black text-white mb-2 uppercase tracking-tighter">{st.name}</h3>
                   <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest mb-6">IA Advanced Confluence</p>
                   
                   <div className="grid grid-cols-2 gap-4 mb-8">
                       <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 text-center">
                          <span className="block text-[8px] text-slate-600 font-black uppercase mb-1">Win Rate</span>
                          <span className="text-xl font-mono font-black text-emerald-500">{st.id === 1 && backtestResult.rate > 0 ? backtestResult.rate : '--'} %</span>
                       </div>
                       <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 text-center">
                          <span className="block text-[8px] text-slate-600 font-black uppercase mb-1">Signals</span>
                          <span className="text-xl font-mono font-black text-blue-500">{st.id === 1 && backtestResult.signals > 0 ? backtestResult.signals : '--'}</span>
                       </div>
                   </div>

                   <div className="space-y-3">
                       {st.id === 1 && (
                           <select 
                            value={selectedAsset} 
                            onChange={(e) => setSelectedAsset(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-[10px] font-black text-white outline-none focus:border-blue-500"
                           >
                              <optgroup label="Forex OTC">
                                <option value="EURUSD-OTC">EUR/USD (OTC)</option>
                                <option value="GBPUSD-OTC">GBP/USD (OTC)</option>
                              </optgroup>
                              <optgroup label="Indices OTC">
                                <option value="FR40-OTC">FR 40 (OTC)</option>
                                <option value="EU50-OTC">EU 50 (OTC)</option>
                              </optgroup>
                              <optgroup label="Crypto OTC">
                                <option value="FET-OTC">FET (OTC)</option>
                                <option value="DYDX-OTC">DYDX (OTC)</option>
                              </optgroup>
                           </select>
                       )}
                       
                       <button 
                        onClick={runBacktest}
                        disabled={isBacktesting || !iqConnected}
                        className="w-full py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all disabled:opacity-20"
                       >
                          {isBacktesting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <History className="w-4 h-4" />}
                          Scann & Backtest
                       </button>

                       <button className={`w-full py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-3 transition-all ${st.isActive ? 'bg-rose-600 text-white' : 'bg-blue-600 hover:bg-blue-50 text-white bg-blue-600 shadow-lg'}`}>
                          {st.isActive ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                          {st.isActive ? 'Detener Bot' : 'Lanzar en Real'}
                       </button>
                   </div>
                </div>
             ))}
          </div>
        )}
        
        {activeTab === 'settings' && (
          <div className="max-w-xl animate-in fade-in slide-in-from-right-4 duration-500">
             <div className="bg-slate-900 border border-slate-800 rounded-3xl p-10 shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 p-8 opacity-5"><ShieldCheck className="w-40 h-40" /></div>
                <h2 className="text-2xl font-black text-white mb-8 uppercase tracking-tighter">Gateway Security</h2>
                <div className="space-y-6">
                   <div>
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 ml-1 px-1">IQ Broker Email</label>
                       <div className="relative">
                          <Mail className="absolute left-6 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                          <input type="email" id="iq_email" placeholder="trade@expert.com" className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-14 pr-6 py-5 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm" />
                       </div>
                   </div>
                   <div>
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 ml-1 px-1">Broker Authentication Token</label>
                       <div className="relative">
                          <Lock className="absolute left-6 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                          <input type={showIqPass ? "text" : "password"} id="iq_pass" placeholder="••••••••" className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-14 pr-12 py-5 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm" />
                          <button onClick={() => setShowIqPass(!showIqPass)} className="absolute right-6 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors">
                              {showIqPass ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                          </button>
                       </div>
                   </div>
                   <button onClick={handleIqLink} disabled={isLinking} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black py-5 px-6 rounded-2xl transition-all shadow-xl uppercase tracking-wider text-xs flex items-center justify-center gap-3">
                     {isLinking ? <RefreshCw className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                     Sincronizar Protocolos Cloud
                   </button>
                </div>
             </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
