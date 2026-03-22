import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBt0sqQhdeAfOSr7zxaJhQBCGZIaAKYUvg",
  authDomain: "tradebotpro-52ce9.firebaseapp.com",
  projectId: "tradebotpro-52ce9",
  storageBucket: "tradebotpro-52ce9.firebasestorage.app",
  messagingSenderId: "429739550148",
  appId: "1:429739550148:web:1b5c9c8dcca790267d3091",
  measurementId: "G-MH4RZGB694"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

export { 
  auth, 
  db, 
  provider, 
  signInWithPopup, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword 
};
