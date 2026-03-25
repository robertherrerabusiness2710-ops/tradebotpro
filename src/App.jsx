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
  EyeOff
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
  
  const socketRef = useRef(null);
  const [strategies, setStrategies] = useState([
    { id: 1, name: 'EMA Cross', isActive: false, backtestRun: false },
    { id: 2, name: 'RSI Extreme', isActive: false, backtestRun: false },
    { id: 3, name: 'Price Action', isActive: false, backtestRun: false }
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

  // CARGAR CONFIGURACIÓN DESDE LA NUBE
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
    } catch (e) {
        console.error("Error cargando config:", e);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (u) {
        setUser(u);
        addLog(`Usuario ${u.email} activo.`);
        if (socketRef.current?.connected) {
            loadUserConfig(u);
        }
      } else {
        setUser(null);
      }
    });

    // CONEXIÓN PRINCIPAL A RENDER
    const GATEWAY_URL = 'https://tradebotpro.onrender.com';
    socketRef.current = io(GATEWAY_URL, {
        reconnection: true,
        reconnectionAttempts: 10,
        transports: ['websocket', 'polling'],
        timeout: 10000
    });

    socketRef.current.on('connect', () => {
        addLog("📶 Sesión Cloud vinculada con éxito.");
        // Si ya hay un usuario al conectar el socket, cargamos su config
        if (auth.currentUser) {
            socketRef.current.emit('auth_link', auth.currentUser.uid);
            loadUserConfig(auth.currentUser);
        }
    });

    socketRef.current.on('connect_error', (err) => {
        addLog(`⚠️ Reintentando conexión con la nube...`);
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

    return () => {
      unsubscribe();
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  useEffect(() => {
    if (user && socketRef.current?.connected) {
        socketRef.current.emit('auth_link', user.uid);
    }
  }, [user]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorStatus('');
    try {
      if (authMode === 'login') {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      setErrorStatus("Error en autenticación");
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithGoogle = async () => {
    try { await signInWithPopup(auth, provider); } catch (e) { setErrorStatus("Fallo en login de Google"); }
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
    addLog("⏳ Guardando y vinculando con el Broker...");

    try {
        // GUARDAR EN FIRESTORE PARA PERSISTENCIA
        await setDoc(doc(db, "users", user.uid), {
            iqEmail,
            iqPassword: iqPass,
            updatedAt: serverTimestamp()
        }, { merge: true });

        // EMITIR AL SERVIDOR
        socketRef.current.emit('connect_iq', { 
            uid: user.uid, 
            email: iqEmail, 
            password: iqPass, 
            mode: 'PRACTICE' 
        });
    } catch (err) {
        console.error("Error guardando config:", err);
        addLog("❌ Error al guardar configuración local");
        setIsLinking(false);
    }
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
                  <input 
                    type="email" 
                    placeholder="ejemplo@gmail.com" 
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm"
                  />
               </div>

               <div className="relative">
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 ml-1 px-1">Contraseña</label>
                  <input 
                    type={showPassword ? "text" : "password"} 
                    placeholder="••••••••" 
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm"
                  />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-5 bottom-4 text-slate-500 hover:text-white transition-colors">
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
               </div>

               {errorStatus && <p className="text-rose-500 text-[10px] font-bold uppercase text-center">{errorStatus}</p>}

               <button 
                 type="submit"
                 disabled={isLoading}
                 className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black py-4 px-6 rounded-2xl transition-all shadow-lg uppercase tracking-wider text-xs"
               >
                 {isLoading ? 'PROCESANDO...' : (authMode === 'login' ? 'INICIAR SESIÓN' : 'REGISTRARSE')}
               </button>
            </form>

            <button 
                onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}
                className="w-full mt-6 text-slate-500 hover:text-blue-400 text-[10px] font-black transition-colors uppercase tracking-widest text-center"
            >
                {authMode === 'login' ? '¿No tienes cuenta? Regístrate aquí' : '¿Ya tienes cuenta? Inicia sesión'}
            </button>
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
                <button 
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`w-full flex items-center px-4 py-4 rounded-2xl transition-all font-black text-xs uppercase tracking-widest ${activeTab === tab ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.3)]' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`}
                >
                  <span className="mr-3">{tab === 'dashboard' ? <Activity className="w-5 h-5" /> : tab === 'strategies' ? <BarChart2 className="w-5 h-5" /> : <Settings className="w-5 h-5" />}</span>
                  {tab}
                </button>
            ))}
        </nav>

        <div className="mt-auto border-t border-slate-800 pt-6">
            <div className="flex items-center gap-4 mb-4">
                <div className="w-10 h-10 bg-slate-800 rounded-xl flex items-center justify-center font-black text-blue-500">{user.email[0].toUpperCase()}</div>
                <div>
                    <p className="text-white font-black text-xs uppercase truncate tracking-tighter">{user.email.split('@')[0]}</p>
                    <p className={`text-[9px] font-black uppercase tracking-widest ${iqConnected ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {iqConnected ? 'Broker Online' : 'Desconectado'}
                    </p>
                </div>
            </div>
            <button onClick={logout} className="w-full flex items-center justify-center gap-2 py-3 bg-rose-600/10 hover:bg-rose-600 text-rose-500 hover:text-white rounded-xl transition-all font-black text-[10px] uppercase">
                <LogOut className="w-4 h-4" /> Finalizar Sesión
            </button>
        </div>
      </aside>

      <main className="flex-1 p-8 md:p-12 overflow-y-auto">
        <header className="mb-10">
            <h1 className="text-4xl font-black text-white uppercase tracking-tighter mb-2">
               {activeTab === 'dashboard' ? 'Panel Operativo' : activeTab === 'strategies' ? 'IA Estratégica' : 'Vínculo al Mercado'}
            </h1>
            <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${socketRef.current?.connected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`}></div>
                <p className="text-slate-500 font-bold uppercase text-[9px] tracking-widest">Gateway Cloud Status: {socketRef.current?.connected ? 'Activo' : 'Offline'}</p>
            </div>
        </header>

        {activeTab === 'dashboard' && (
          <div className="space-y-6">
              <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-xl flex justify-between items-center bg-gradient-to-br from-slate-900 to-slate-950">
                  <div className="flex items-center gap-5">
                      <div className="p-4 bg-blue-500/10 rounded-2xl border border-blue-500/10"><Zap className="w-8 h-8 text-blue-500 animate-pulse" /></div>
                      <div>
                          <span className="text-slate-500 text-[10px] uppercase font-black tracking-widest block font-mono">FEED EUR/USD</span>
                          <span className="text-4xl font-mono font-black text-blue-500 leading-none">{livePrice.price}</span>
                      </div>
                  </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
                      <h3 className="text-slate-500 text-[10px] font-black uppercase tracking-widest mb-1">Total Real</h3>
                      <p className="text-3xl font-black text-emerald-500">$ {balances.real}</p>
                  </div>
                  <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
                      <h3 className="text-slate-500 text-[10px] font-black uppercase tracking-widest mb-1">Cta. Práctica</h3>
                      <p className="text-3xl font-black text-amber-500">$ {balances.demo}</p>
                  </div>
              </div>
              <div className="bg-slate-900/50 rounded-2xl border border-slate-800 p-6">
                   <h3 className="text-white font-black text-xs uppercase mb-4 tracking-widest flex items-center gap-2"><Activity className="w-4 h-4 text-blue-500" /> Monitor en la Nube</h3>
                   <div className="space-y-2 h-40 overflow-y-auto font-mono text-[10px] custom-scrollbar">
                      {logs.map((log, i) => (
                        <div key={i} className="flex gap-3 border-l-2 border-slate-800 pl-3">
                           <span className="text-slate-600">{log.time}</span>
                           <span className="text-slate-300">{log.msg}</span>
                        </div>
                      ))}
                   </div>
              </div>
          </div>
        )}
        
        {activeTab === 'settings' && (
          <div className="max-w-xl animate-in zoom-in-95 duration-500">
             <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-10"><Globe className="w-20 h-20" /></div>
                <h2 className="text-xl font-black text-white mb-6 uppercase tracking-tight">Acceso IQ Option en Cloud</h2>
                <div className="space-y-4">
                   <div>
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 px-1">Usuario IQ (Email)</label>
                       <input 
                         type="email" 
                         id="iq_email"
                         placeholder="correo@ejemplo.com"
                         className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm"
                       />
                   </div>
                   <div className="relative">
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 px-1">Contraseña Broker</label>
                       <input 
                         type={showIqPass ? "text" : "password"} 
                         id="iq_pass"
                         placeholder="••••••••"
                         className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm"
                       />
                       <button onClick={() => setShowIqPass(!showIqPass)} className="absolute right-5 bottom-4 text-slate-500 hover:text-white transition-colors">
                          {showIqPass ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                       </button>
                   </div>
                   <button 
                     onClick={handleIqLink}
                     disabled={isLinking}
                     className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black py-5 px-6 rounded-2xl transition-all shadow-lg uppercase tracking-wider text-xs flex items-center justify-center"
                   >
                     {isLinking ? <RefreshCw className="w-5 h-5 animate-spin" /> : 'Sincronizar con el Mercado'}
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
