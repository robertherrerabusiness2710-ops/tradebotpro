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
  UserPlus
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
  const [authMode, setAuthMode] = useState('login'); // login | register
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorStatus, setErrorStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  
  const [activeTab, setActiveTab] = useState('dashboard');
  const [balances, setBalances] = useState({ demo: '0.00', real: '0.00' });
  const [livePrice, setLivePrice] = useState({ pair: 'EUR/USD', price: '1.08542', timestamp: '--' });
  const [iqConnected, setIqConnected] = useState(false);
  const [iqProfile, setIqProfile] = useState(null);
  const [logs, setLogs] = useState([]);
  
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

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (u) {
        setUser(u);
        addLog(`Usuario ${u.email} autenticado.`);
      } else {
        setUser(null);
      }
    });

    socketRef.current = io('http://localhost:3001');
    socketRef.current.on('price_update', (data) => setLivePrice(data));
    socketRef.current.on('balance_sync', (data) => setBalances(data));
    socketRef.current.on('iq_connected', (profile) => {
      setIqConnected(true);
      setIqProfile(profile);
    });
    return () => {
      unsubscribe();
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  useEffect(() => {
    if (user && socketRef.current) socketRef.current.emit('auth_link', user.uid);
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
      setErrorStatus(err.message.includes('auth/') ? 'Error en credenciales o servidor' : err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithGoogle = async () => {
    try { await signInWithPopup(auth, provider); } catch (e) { setErrorStatus("Fallo en login con Google"); }
  };

  const logout = async () => {
    await signOut(auth);
    setIqConnected(false);
    setUser(null);
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-10 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-600 via-indigo-500 to-blue-600 animate-pulse"></div>
            
            <div className="w-16 h-16 bg-blue-600/20 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-blue-500/20">
                <ShieldCheck className="w-8 h-8 text-blue-500" />
            </div>
            
            <h1 className="text-2xl font-black text-white mb-1 text-center uppercase tracking-tight">Acceso TradeBot PRO</h1>
            <p className="text-slate-500 mb-8 text-center text-xs font-medium uppercase tracking-widest">Plataforma de Trading Algorítmico</p>
            
            <form onSubmit={handleAuth} className="space-y-4">
               <div className="relative group">
                  <Mail className="absolute left-4 top-4 w-5 h-5 text-slate-500 group-focus-within:text-blue-500 transition-colors" />
                  <input 
                    type="email" 
                    placeholder="Tu correo" 
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-6 py-4 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm"
                  />
               </div>

               <div className="relative group">
                  <Lock className="absolute left-4 top-4 w-5 h-5 text-slate-500 group-focus-within:text-blue-500 transition-colors" />
                  <input 
                    type="password" 
                    placeholder="Tu contraseña" 
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-6 py-4 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm"
                  />
               </div>

               {errorStatus && (
                 <div className="flex items-center gap-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-400">
                    <AlertCircle className="w-4 h-4" />
                    {errorStatus}
                 </div>
               )}

               <button 
                 type="submit"
                 disabled={isLoading}
                 className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black py-4 px-6 rounded-2xl transition-all shadow-lg shadow-blue-500/20 uppercase tracking-wider text-sm flex items-center justify-center"
               >
                 {isLoading ? <RefreshCw className="w-5 h-5 animate-spin" /> : (authMode === 'login' ? 'Iniciar Sesión' : 'Crear Cuenta')}
               </button>
            </form>

            <div className="flex items-center gap-4 my-8">
              <div className="flex-1 h-[1px] bg-slate-800"></div>
              <span className="text-slate-700 text-[10px] font-black uppercase tracking-widest">O entrar con</span>
              <div className="flex-1 h-[1px] bg-slate-800"></div>
            </div>

            <button 
                onClick={loginWithGoogle}
                className="w-full bg-slate-950 border border-slate-800 text-white font-bold py-4 px-6 rounded-2xl flex items-center justify-center hover:bg-slate-800 transition-all duration-300 shadow-md group"
            >
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5 mr-3 group-hover:scale-110 transition-transform" alt="Google" />
                Google Account
            </button>

            <button 
                onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}
                className="w-full mt-6 text-slate-500 hover:text-blue-400 text-xs font-bold transition-colors uppercase tracking-widest flex items-center justify-center gap-2"
            >
                {authMode === 'login' ? (
                  <>¿Sin cuenta aún? <span className="text-blue-500 border-b border-blue-500/30 pb-0.5">Regístrate gratis</span></>
                ) : (
                  <>¿Ya tienes cuenta? <span className="text-blue-500 border-b border-blue-500/30 pb-0.5">Accede ahora</span></>
                )}
            </button>
        </div>
      </div>
    );
  }

  const renderDashboard = () => (
    <div className="space-y-6">
        <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-xl">
            <div className="flex flex-col md:flex-row justify-between items-center gap-6">
                <div className="flex items-center gap-4">
                    <div className="p-4 bg-blue-500/10 rounded-2xl border border-blue-500/10">
                        <Zap className="w-8 h-8 text-blue-500" />
                    </div>
                    <div>
                        <span className="text-slate-500 text-[10px] uppercase font-black tracking-widest block mb-1">Mercado Live</span>
                        <div className="flex items-baseline gap-3">
                            <span className="text-4xl font-black text-white">{livePrice.pair}</span>
                            <span className="text-4xl font-mono font-black text-blue-500">{livePrice.price}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-900/50 p-6 rounded-2xl border border-slate-800 hover:border-blue-500/20 transition-all">
                <h3 className="text-slate-500 text-[10px] font-black uppercase tracking-widest mb-1">Saldos Reales</h3>
                <p className="text-3xl font-black text-white tracking-tighter">$ {balances.real}</p>
            </div>
            <div className="bg-slate-900/50 p-6 rounded-2xl border border-slate-800">
                <h3 className="text-slate-500 text-[10px] font-black uppercase tracking-widest mb-1">Cta. Práctica</h3>
                <p className="text-3xl font-black text-white tracking-tighter">$ {balances.demo}</p>
            </div>
        </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col md:flex-row">
      <aside className="w-full md:w-80 bg-slate-900 border-r border-slate-800 flex flex-col p-8">
        <div className="flex items-center gap-3 mb-12">
            <Activity className="w-8 h-8 text-blue-500" />
            <span className="text-xl font-black text-white uppercase tracking-tighter">TradeBot PRO</span>
        </div>
        
        <nav className="flex-1 space-y-2">
            {['dashboard', 'strategies', 'settings'].map(tab => (
                <button 
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`w-full flex items-center px-4 py-4 rounded-2xl transition-all font-black text-xs uppercase tracking-widest ${activeTab === tab ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`}
                >
                  <span className="shrink-0">{tab === 'dashboard' ? <Activity className="w-5 h-5 mr-3" /> : tab === 'strategies' ? <BarChart2 className="w-5 h-5 mr-3" /> : <Settings className="w-5 h-5 mr-3" />}</span>
                  {tab}
                </button>
            ))}
        </nav>

        <div className="mt-auto border-t border-slate-800 pt-6">
            <div className="flex items-center gap-4 mb-6 p-3 bg-slate-950 rounded-2xl border border-slate-800">
                <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center font-black text-white">{user.email[0].toUpperCase()}</div>
                <div className="overflow-hidden">
                    <p className="text-white font-bold text-xs truncate uppercase tracking-tighter">{user.email.split('@')[0]}</p>
                    <p className="text-slate-600 text-[9px] font-bold uppercase tracking-widest">{iqConnected ? 'Broker Activo' : 'Offline'}</p>
                </div>
            </div>
            <button 
                onClick={logout}
                className="w-full flex items-center justify-center gap-2 py-3 bg-rose-600/10 hover:bg-rose-600 text-rose-500 hover:text-white rounded-xl transition-all font-bold text-xs uppercase"
            >
                <LogOut className="w-4 h-4" />
                Cerrar Sesión
            </button>
        </div>
      </aside>

      <main className="flex-1 p-8 md:p-12 overflow-y-auto">
        <header className="mb-12 flex justify-between items-end">
            <div>
                <h1 className="text-4xl font-black text-white uppercase tracking-tighter">
                   {activeTab === 'dashboard' ? 'Centro de Mando' : activeTab === 'strategies' ? 'IA Algorítmica' : 'Vínculo IQ Option'}
                </h1>
                <p className="text-slate-500 font-bold uppercase text-[9px] mt-1 tracking-widest">Estado del Sistema: 100% cloud optimized</p>
            </div>
        </header>

        {activeTab === 'dashboard' && renderDashboard()}
        
        {activeTab === 'settings' && (
          <div className="max-w-xl animate-in zoom-in-95 duration-500 h-full">
             <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl backdrop-blur-md">
                <h2 className="text-xl font-black text-white mb-6 uppercase tracking-tight">Enlaza tu cuenta de IQ Option</h2>
                <div className="space-y-4">
                   <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl text-emerald-400 text-xs font-bold uppercase tracking-tight">
                      <ShieldCheck className="w-4 h-4 inline mr-2" />
                      Tus credenciales se sincronizarán en la nube de forma segura.
                   </div>
                   <div>
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 px-1">Email del Broker</label>
                       <input 
                         type="email" 
                         id="iq_email"
                         placeholder="cuenta@broker.com"
                         className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm shadow-inner"
                       />
                   </div>
                   <div>
                       <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 px-1">Contraseña</label>
                       <input 
                         type="password" 
                         id="iq_pass"
                         placeholder="••••••••"
                         className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-blue-500 transition-all font-mono text-sm shadow-inner"
                       />
                   </div>
                   <button 
                     onClick={() => {
                        const email = document.getElementById('iq_email').value;
                        const pass = document.getElementById('iq_pass').value;
                        if(email && pass) socketRef.current.emit('connect_iq', { uid: user.uid, email, password: pass, mode: 'PRACTICE' });
                     }}
                     className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black py-5 px-6 rounded-2xl transition-all shadow-lg shadow-blue-500/20 uppercase tracking-wider text-xs"
                   >
                     Vincular Ahora
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
