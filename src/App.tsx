/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { Phone, PhoneOff, Mic, Send, MoreVertical, Plus, Image as ImageIcon, Paperclip, X, LogOut, LogIn, Video, VideoOff, MessageCircle, Droplets } from 'lucide-react';
import { auth, db } from './firebase';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut, 
  User,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  ConfirmationResult
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  onSnapshot, 
  serverTimestamp, 
  Timestamp,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  limit,
  where,
  getDocs,
  getDocFromServer
} from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let displayMessage = "Something went wrong.";
      try {
        const parsed = JSON.parse(this.state.error?.message || "");
        if (parsed.error) displayMessage = `Error: ${parsed.error}`;
      } catch (e) {
        displayMessage = this.state.error?.message || displayMessage;
      }

      return (
        <div className="h-screen w-full flex items-center justify-center bg-slate-950 text-white p-10 text-center">
          <div className="glass-effect p-8 rounded-3xl border border-red-500/30 max-w-md">
            <h2 className="text-2xl font-black mb-4 text-red-500">SYSTEM ERROR</h2>
            <p className="text-sm text-slate-400 mb-6">{displayMessage}</p>
            <button 
              onClick={() => window.location.reload()} 
              className="px-6 py-3 bg-cyan-500 text-white font-black rounded-xl hover:bg-cyan-400 transition-all"
            >
              RELOAD APP
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

interface Message {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: any;
  read: boolean;
}

interface Contact {
  uid: string;
  displayName: string;
  photoURL: string;
  phoneNumber: string;
  status: 'online' | 'offline';
  lastSeen: any;
}

const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

const DOLOR_CHAT = () => {
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState('chat');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [onCall, setOnCall] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [isVideoCall, setIsVideoCall] = useState(false);
  const [isIncomingCall, setIsIncomingCall] = useState(false);
  const [currentCallId, setCurrentCallId] = useState<string | null>(null);
  
  // Phone Auth State
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otp, setOtp] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState('');

  // Contacts State
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [searchPhone, setSearchPhone] = useState('');
  const [isAddingContact, setIsAddingContact] = useState(false);
  
  const pc = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Auth Listener & Presence
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. ");
          setError("Firebase is offline. Check your connection or configuration.");
        }
      }
    }
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const userRef = doc(db, 'users', currentUser.uid);
        try {
          await setDoc(userRef, {
            uid: currentUser.uid,
            displayName: currentUser.displayName || `User ${currentUser.phoneNumber?.slice(-4)}`,
            photoURL: currentUser.photoURL || `https://picsum.photos/seed/${currentUser.uid}/200/200`,
            phoneNumber: currentUser.phoneNumber,
            status: 'online',
            lastSeen: serverTimestamp()
          }, { merge: true });
        } catch (e) {
          handleFirestoreError(e, OperationType.WRITE, `users/${currentUser.uid}`);
        }

        // Update status to offline on unmount or logout
        const setOffline = async () => {
          try {
            await updateDoc(userRef, {
              status: 'offline',
              lastSeen: serverTimestamp()
            });
          } catch (e) {
            console.error("Failed to set offline status", e);
          }
        };

        window.addEventListener('beforeunload', setOffline);
        return () => {
          setOffline();
          window.removeEventListener('beforeunload', setOffline);
        };
      }
    });
    return () => unsubscribe();
  }, []);

  // Listen for Contacts
  useEffect(() => {
    if (!user) return;
    const userRef = doc(db, 'users', user.uid);
    const unsubscribe = onSnapshot(userRef, async (docSnap) => {
      if (docSnap.exists()) {
        const userData = docSnap.data();
        const contactIds = userData.contacts || [];
        if (contactIds.length > 0) {
          // Listen to each contact's status
          const contactsQuery = query(collection(db, 'users'), where('uid', 'in', contactIds));
          const unsubContacts = onSnapshot(contactsQuery, (snap) => {
            const contactList = snap.docs.map(d => d.data() as Contact);
            setContacts(contactList);
          }, (err) => {
            handleFirestoreError(err, OperationType.LIST, 'users');
          });
          return () => unsubContacts();
        } else {
          setContacts([]);
        }
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, `users/${user.uid}`);
    });
    return () => unsubscribe();
  }, [user]);

  const setupRecaptcha = () => {
    if (!(window as any).recaptchaVerifier) {
      (window as any).recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
        size: 'invisible',
        callback: () => {
          console.log('Recaptcha resolved');
        }
      });
    }
  };

  const handleSendOtp = async () => {
    setError('');
    setIsVerifying(true);
    try {
      setupRecaptcha();
      const appVerifier = (window as any).recaptchaVerifier;
      const result = await signInWithPhoneNumber(auth, phoneNumber, appVerifier);
      setConfirmationResult(result);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to send OTP. Make sure the number is in international format (e.g., +1234567890)');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleVerifyOtp = async () => {
    setError('');
    setIsVerifying(true);
    try {
      if (confirmationResult) {
        await confirmationResult.confirm(otp);
      }
    } catch (err: any) {
      console.error(err);
      setError('Invalid OTP. Please try again.');
    } finally {
      setIsVerifying(false);
    }
  };

  const addContactByPhone = async () => {
    if (!user || !searchPhone) return;
    setIsAddingContact(true);
    setError('');
    try {
      const q = query(collection(db, 'users'), where('phoneNumber', '==', searchPhone));
      const querySnapshot = await getDocs(q);
      
      if (querySnapshot.empty) {
        setError('User not found with this phone number.');
      } else {
        const contactDoc = querySnapshot.docs[0];
        const contactId = contactDoc.id;
        
        if (contactId === user.uid) {
          setError("You can't add yourself.");
          return;
        }

        const userRef = doc(db, 'users', user.uid);
        let userDoc;
        try {
          userDoc = await getDoc(userRef);
        } catch (e) {
          handleFirestoreError(e, OperationType.GET, `users/${user.uid}`);
          return;
        }
        const currentContacts = userDoc.data()?.contacts || [];
        
        if (currentContacts.includes(contactId)) {
          setError('Contact already added.');
        } else {
          await updateDoc(userRef, {
            contacts: [...currentContacts, contactId]
          });
          setSearchPhone('');
          setActiveTab('contacts');
        }
      }
    } catch (err: any) {
      console.error(err);
      handleFirestoreError(err, OperationType.WRITE, 'users');
    } finally {
      setIsAddingContact(false);
    }
  };

  // Listen for incoming calls
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'calls'), limit(1));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          if (data.receiverId === user.uid && data.status === 'ringing') {
            setCurrentCallId(change.doc.id);
            setIsIncomingCall(true);
            setIsVideoCall(data.type === 'video');
            playNotificationSound();
          }
        } else if (change.type === 'modified') {
          const data = change.doc.data();
          if (data.status === 'ended' && change.doc.id === currentCallId) {
            cleanupCall();
          }
        }
      });
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, 'calls');
    });
    return () => unsubscribe();
  }, [user, currentCallId]);

  // Real-time Messages
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'messages'), orderBy('timestamp', 'asc'));
    let initialLoad = true;

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Message[];
      
      // Notify for new messages after initial load
      if (!initialLoad && snapshot.docChanges().some(change => change.type === 'added')) {
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg.senderId !== user.uid) {
          playNotificationSound();
          speakNotification(lastMsg.senderName);
        }
      }
      
      setMessages(msgs);
      initialLoad = false;
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, 'messages');
    });
    return () => unsubscribe();
  }, [user]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Call timer
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (onCall) {
      interval = setInterval(() => {
        setCallDuration(prev => prev + 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [onCall]);

  const playNotificationSound = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(e => console.log("Audio play blocked", e));
    }
  };

  const speakNotification = (name: string) => {
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(`New message from ${name}`);
      utterance.rate = 1.1;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    }
  };

  const setupWebRTC = async () => {
    pc.current = new RTCPeerConnection(servers);
    remoteStream.current = new MediaStream();

    localStream.current?.getTracks().forEach((track) => {
      pc.current?.addTrack(track, localStream.current!);
    });

    pc.current.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        remoteStream.current?.addTrack(track);
      });
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream.current;
      }
    };
  };

  const startCall = async (video = false) => {
    if (!user) return;
    setIsVideoCall(video);
    setOnCall(true);
    setCallDuration(0);

    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({
        video: video,
        audio: true,
      });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream.current;
      }

      await setupWebRTC();

      const callDoc = doc(collection(db, 'calls'));
      setCurrentCallId(callDoc.id);

      const offerCandidates = collection(callDoc, 'offerCandidates');
      const answerCandidates = collection(callDoc, 'answerCandidates');

      pc.current!.onicecandidate = (event) => {
        event.candidate && addDoc(offerCandidates, event.candidate.toJSON());
      };

      const offerDescription = await pc.current!.createOffer();
      await pc.current!.setLocalDescription(offerDescription);

      const offer = {
        sdp: offerDescription.sdp,
        type: offerDescription.type,
      };

      try {
        await setDoc(callDoc, { 
          offer, 
          callerId: user.uid, 
          status: 'ringing', 
          type: video ? 'video' : 'audio' 
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, `calls/${callDoc.id}`);
      }

      onSnapshot(callDoc, (snapshot) => {
        const data = snapshot.data();
        if (!pc.current!.currentRemoteDescription && data?.answer) {
          const answerDescription = new RTCSessionDescription(data.answer);
          pc.current!.setRemoteDescription(answerDescription);
        }
      }, (err) => {
        handleFirestoreError(err, OperationType.GET, `calls/${callDoc.id}`);
      });

      onSnapshot(answerCandidates, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            pc.current!.addIceCandidate(candidate);
          }
        });
      }, (err) => {
        handleFirestoreError(err, OperationType.LIST, `calls/${callDoc.id}/answerCandidates`);
      });

    } catch (e) {
      console.error("Failed to start call", e);
      cleanupCall();
    }
  };

  const answerCall = async () => {
    if (!user || !currentCallId) return;
    setIsIncomingCall(false);
    setOnCall(true);

    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({
        video: isVideoCall,
        audio: true,
      });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream.current;
      }

      await setupWebRTC();

      const callDoc = doc(db, 'calls', currentCallId);
      const answerCandidates = collection(callDoc, 'answerCandidates');
      const offerCandidates = collection(callDoc, 'offerCandidates');

      pc.current!.onicecandidate = (event) => {
        event.candidate && addDoc(answerCandidates, event.candidate.toJSON());
      };

      let callData;
      try {
        const callSnap = await getDoc(callDoc);
        callData = callSnap.data();
      } catch (e) {
        handleFirestoreError(e, OperationType.GET, `calls/${currentCallId}`);
        return;
      }
      const offerDescription = callData?.offer;
      await pc.current!.setRemoteDescription(new RTCSessionDescription(offerDescription));

      const answerDescription = await pc.current!.createAnswer();
      await pc.current!.setLocalDescription(answerDescription);

      const answer = {
        type: answerDescription.type,
        sdp: answerDescription.sdp,
      };

      try {
        await updateDoc(callDoc, { answer, status: 'active' });
      } catch (e) {
        handleFirestoreError(e, OperationType.UPDATE, `calls/${currentCallId}`);
      }

      onSnapshot(offerCandidates, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const data = change.doc.data();
            pc.current!.addIceCandidate(new RTCIceCandidate(data));
          }
        });
      }, (err) => {
        handleFirestoreError(err, OperationType.LIST, `calls/${currentCallId}/offerCandidates`);
      });

    } catch (e) {
      console.error("Failed to answer call", e);
      cleanupCall();
    }
  };

  const endCall = async () => {
    if (currentCallId) {
      await updateDoc(doc(db, 'calls', currentCallId), { status: 'ended' });
    }
    cleanupCall();
  };

  const cleanupCall = () => {
    localStream.current?.getTracks().forEach(track => track.stop());
    pc.current?.close();
    pc.current = null;
    localStream.current = null;
    remoteStream.current = null;
    setOnCall(false);
    setIsIncomingCall(false);
    setCurrentCallId(null);
    setCallDuration(0);
  };

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleLogout = () => signOut(auth);

  const sendMessage = async () => {
    if (inputText.trim() && user) {
      const text = inputText;
      setInputText('');
      try {
        await addDoc(collection(db, 'messages'), {
          senderId: user.uid,
          senderName: user.displayName,
          text: text,
          timestamp: serverTimestamp(),
          read: false
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, 'messages');
      }
    }
  };

  const formatCallDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours > 0 ? hours + ':' : ''}${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (!user) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-slate-950 font-mono overflow-hidden relative">
        <div id="recaptcha-container"></div>
        {/* Background Splash Effect */}
        <div className="absolute inset-0 opacity-20">
          <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-cyan-500 blur-[120px] rounded-full"></div>
          <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-blue-600 blur-[120px] rounded-full"></div>
        </div>

        <div className="text-center p-10 glass-effect rounded-[40px] border border-cyan-400/20 max-w-md w-full mx-4 relative z-10 shadow-2xl">
          <div className="relative inline-block mb-8">
            <div className="w-24 h-24 bg-gradient-to-br from-cyan-400 to-blue-600 rounded-3xl flex items-center justify-center shadow-lg shadow-cyan-500/20 transform rotate-12">
              <Droplets size={48} className="text-white -rotate-12" />
            </div>
            <div className="absolute -top-2 -right-2 w-8 h-8 bg-white rounded-full flex items-center justify-center shadow-md">
              <MessageCircle size={18} className="text-cyan-600" />
            </div>
          </div>
          
          <h1 className="text-4xl font-black text-white mb-2 tracking-tighter">DOLOR CHAT</h1>
          <p className="text-cyan-400 font-bold text-lg mb-8 tracking-widest uppercase">SPLASH</p>
          
          <div className="space-y-4">
            {!confirmationResult ? (
              <>
                <div className="bg-slate-900/80 rounded-2xl px-5 py-4 border border-cyan-900/30 focus-within:border-cyan-400/50 transition-all shadow-inner">
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="+1234567890"
                    className="w-full bg-transparent text-white placeholder-slate-600 outline-none text-sm font-medium"
                  />
                </div>
                <button 
                  onClick={handleSendOtp}
                  disabled={isVerifying || !phoneNumber}
                  className="w-full py-5 bg-gradient-to-r from-cyan-400 to-blue-500 text-white font-black rounded-2xl flex items-center justify-center gap-3 hover:scale-[1.02] active:scale-95 transition-all shadow-xl shadow-cyan-500/30 disabled:opacity-50"
                >
                  {isVerifying ? 'SENDING...' : 'SEND OTP'}
                </button>
              </>
            ) : (
              <>
                <div className="bg-slate-900/80 rounded-2xl px-5 py-4 border border-cyan-900/30 focus-within:border-cyan-400/50 transition-all shadow-inner">
                  <input
                    type="text"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    placeholder="Enter 6-digit OTP"
                    className="w-full bg-transparent text-white placeholder-slate-600 outline-none text-sm font-medium text-center tracking-[0.5em]"
                  />
                </div>
                <button 
                  onClick={handleVerifyOtp}
                  disabled={isVerifying || !otp}
                  className="w-full py-5 bg-gradient-to-r from-cyan-400 to-blue-500 text-white font-black rounded-2xl flex items-center justify-center gap-3 hover:scale-[1.02] active:scale-95 transition-all shadow-xl shadow-cyan-500/30 disabled:opacity-50"
                >
                  {isVerifying ? 'VERIFYING...' : 'VERIFY OTP'}
                </button>
                <button 
                  onClick={() => setConfirmationResult(null)}
                  className="text-cyan-400 text-xs font-bold uppercase tracking-widest hover:underline"
                >
                  Change Number
                </button>
              </>
            )}
            {error && <p className="text-red-500 text-xs font-bold mt-2">{error}</p>}
          </div>
          
          <p className="mt-8 text-slate-500 text-xs uppercase tracking-widest">Premium Messaging Experience</p>
        </div>
        <style>{`
          .glass-effect {
            background: rgba(15, 23, 42, 0.6);
            backdrop-filter: blur(20px);
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950 font-mono text-slate-200">
      <audio ref={audioRef} src="https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3" preload="auto" />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;800&family=Space+Mono:wght@400;700&display=swap');
        * { font-family: 'JetBrains Mono', monospace; }
        @keyframes floatIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse-cyan { 0%, 100% { box-shadow: 0 0 8px rgba(6, 182, 212, 0.3), inset 0 0 8px rgba(6, 182, 212, 0.1); } 50% { box-shadow: 0 0 20px rgba(6, 182, 212, 0.6), inset 0 0 12px rgba(6, 182, 212, 0.2); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes breathe { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
        .message-animation { animation: floatIn 0.4s ease-out forwards; }
        .active-indicator { animation: pulse-cyan 2s ease-in-out infinite; }
        .typing-indicator span { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #22d3ee; margin: 0 3px; animation: breathe 1.4s infinite; }
        .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
        .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
        .call-wave { animation: slideUp 0.6s ease-out; }
        .glass-effect { background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(15px); border: 1px solid rgba(34, 211, 238, 0.1); }
        .cyan-glow { background: linear-gradient(135deg, rgba(34, 211, 238, 0.1) 0%, rgba(34, 211, 238, 0.05) 100%); border: 1px solid rgba(34, 211, 238, 0.2); }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
      `}</style>

      <div className="w-full h-full flex flex-col max-w-2xl mx-auto bg-slate-950/40 shadow-2xl overflow-hidden border-x border-cyan-900/20">
        {/* Header */}
        <div className="glass-effect border-b border-cyan-900/30 px-6 py-4 flex items-center justify-between z-20">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="w-12 h-12 rounded-2xl overflow-hidden border-2 border-cyan-400 active-indicator rotate-3">
                <img
                  src={user.photoURL || "https://picsum.photos/seed/user/200/200"}
                  alt="Avatar"
                  className="w-full h-full object-cover -rotate-3"
                  referrerPolicy="no-referrer"
                />
              </div>
              <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-cyan-400 rounded-full border-2 border-slate-900 animate-pulse"></div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-extrabold text-white tracking-tight uppercase">{user.displayName}</h1>
                <Droplets size={14} className="text-cyan-400 animate-bounce" />
              </div>
              <p className="text-[10px] text-cyan-400/70 font-bold tracking-widest uppercase">Splash Active</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleLogout} className="p-2 hover:bg-red-500/20 rounded-xl transition text-slate-400 hover:text-red-400" title="Logout">
              <LogOut size={20} />
            </button>
            <button className="p-2 hover:bg-cyan-500/20 rounded-xl transition text-slate-400 hover:text-cyan-400">
              <MoreVertical size={20} />
            </button>
          </div>
        </div>

        {/* Incoming Call Overlay */}
        {isIncomingCall && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/90 backdrop-blur-xl">
            <div className="text-center p-10 glass-effect rounded-[40px] border border-cyan-400/50 call-wave shadow-2xl shadow-cyan-500/20">
              <div className="w-28 h-28 rounded-full bg-cyan-500/20 mx-auto mb-8 flex items-center justify-center animate-pulse border-2 border-cyan-400/30">
                <Phone size={48} className="text-cyan-400" />
              </div>
              <h2 className="text-3xl font-black text-white mb-2 tracking-tighter">INCOMING SPLASH</h2>
              <p className="text-cyan-400/80 font-bold mb-10 tracking-widest uppercase text-xs">Someone is calling your heart...</p>
              <div className="flex gap-4">
                <button onClick={answerCall} className="flex-1 py-5 bg-cyan-500 text-white font-black rounded-2xl hover:bg-cyan-400 active:scale-95 transition-all shadow-lg shadow-cyan-500/30">
                  ANSWER
                </button>
                <button onClick={endCall} className="flex-1 py-5 bg-red-600 text-white font-black rounded-2xl hover:bg-red-500 active:scale-95 transition-all shadow-lg shadow-red-600/30">
                  DECLINE
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Chat Area / Call Area / Contacts Area */}
        {!onCall ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            {activeTab === 'chat' && (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto scrollbar-hide px-6 py-6 space-y-6">
                  {messages.map((msg, idx) => (
                    <div key={msg.id} className={`message-animation flex ${msg.senderId === user.uid ? 'justify-end' : 'justify-start'}`} style={{ animationDelay: `${idx * 0.05}s` }}>
                      <div className={`max-w-[85%] px-5 py-4 rounded-[24px] shadow-lg ${
                        msg.senderId === user.uid 
                          ? 'bg-gradient-to-br from-cyan-500 to-blue-600 text-white font-medium rounded-tr-none' 
                          : 'cyan-glow text-slate-100 rounded-tl-none'
                      }`}>
                        {msg.senderId !== user.uid && (
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-[10px] text-cyan-400 font-black uppercase tracking-tighter">{msg.senderName}</p>
                            <div className={`w-1.5 h-1.5 rounded-full ${contacts.find(c => c.uid === msg.senderId)?.status === 'online' ? 'bg-cyan-400 animate-pulse' : 'bg-slate-600'}`}></div>
                          </div>
                        )}
                        <p className="text-sm leading-relaxed">{msg.text}</p>
                        <div className={`flex items-center justify-end gap-1 mt-2 ${msg.senderId === user.uid ? 'text-white/60' : 'text-slate-500'}`}>
                          <span className="text-[9px] font-bold">
                            {msg.timestamp instanceof Timestamp ? msg.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '...'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>

                <div className="glass-effect border-t border-cyan-900/30 px-6 py-5">
                  <div className="flex items-end gap-3">
                    <button className="p-3 hover:bg-cyan-500/10 rounded-2xl transition text-slate-500 hover:text-cyan-400"><Plus size={22} /></button>
                    <div className="flex-1 bg-slate-900/80 rounded-[22px] px-5 py-3 border border-cyan-900/30 focus-within:border-cyan-400/50 transition-all shadow-inner">
                      <input
                        type="text"
                        value={inputText}
                        onChange={(e) => setInputText(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                        placeholder="Splash a message..."
                        className="w-full bg-transparent text-white placeholder-slate-600 outline-none text-sm font-medium"
                      />
                    </div>
                    {inputText.trim() ? (
                      <button onClick={sendMessage} className="p-4 bg-gradient-to-r from-cyan-400 to-blue-500 hover:scale-105 active:scale-95 transition-all text-white font-black rounded-2xl shadow-lg shadow-cyan-500/20">
                        <Send size={20} />
                      </button>
                    ) : (
                      <button className="p-3 hover:bg-cyan-500/10 rounded-2xl transition text-slate-500 hover:text-cyan-400"><Mic size={22} /></button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'contacts' && (
              <div className="flex-1 flex flex-col overflow-hidden p-6">
                <div className="mb-8">
                  <h2 className="text-xl font-black text-white mb-4 tracking-tighter uppercase">Add Contact</h2>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-slate-900/80 rounded-2xl px-5 py-3 border border-cyan-900/30 focus-within:border-cyan-400/50 transition-all shadow-inner">
                      <input
                        type="tel"
                        value={searchPhone}
                        onChange={(e) => setSearchPhone(e.target.value)}
                        placeholder="+1234567890"
                        className="w-full bg-transparent text-white placeholder-slate-600 outline-none text-sm font-medium"
                      />
                    </div>
                    <button 
                      onClick={addContactByPhone}
                      disabled={isAddingContact || !searchPhone}
                      className="p-4 bg-cyan-500 text-white font-black rounded-2xl hover:bg-cyan-400 active:scale-95 transition-all shadow-lg shadow-cyan-500/20 disabled:opacity-50"
                    >
                      <Plus size={20} />
                    </button>
                  </div>
                  {error && <p className="text-red-500 text-[10px] font-bold mt-2 uppercase tracking-widest">{error}</p>}
                </div>

                <div className="flex-1 overflow-y-auto scrollbar-hide space-y-4">
                  <h2 className="text-xs font-black text-cyan-400/60 mb-4 tracking-[0.2em] uppercase">Your Contacts ({contacts.length})</h2>
                  {contacts.length === 0 ? (
                    <div className="text-center py-10 opacity-30">
                      <MessageCircle size={48} className="mx-auto mb-4" />
                      <p className="text-xs font-bold uppercase tracking-widest">No contacts yet</p>
                    </div>
                  ) : (
                    contacts.map(contact => (
                      <div key={contact.uid} className="glass-effect p-4 rounded-3xl flex items-center justify-between hover:bg-cyan-500/5 transition-all group">
                        <div className="flex items-center gap-4">
                          <div className="relative">
                            <div className={`w-12 h-12 rounded-2xl overflow-hidden border-2 ${contact.status === 'online' ? 'border-cyan-400' : 'border-slate-700'} transition-all`}>
                              <img src={contact.photoURL} alt={contact.displayName} className="w-full h-full object-cover" />
                            </div>
                            <div className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-slate-900 ${contact.status === 'online' ? 'bg-cyan-400 animate-pulse' : 'bg-slate-600'}`}></div>
                          </div>
                          <div>
                            <h3 className="text-sm font-black text-white uppercase tracking-tight">{contact.displayName}</h3>
                            <p className="text-[10px] text-slate-500 font-bold tracking-widest uppercase">
                              {contact.status === 'online' ? 'Online Now' : `Last seen ${contact.lastSeen instanceof Timestamp ? contact.lastSeen.toDate().toLocaleTimeString() : 'recently'}`}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-all">
                          <button onClick={() => { setActiveTab('chat'); }} className="p-2 bg-cyan-500/10 text-cyan-400 rounded-xl hover:bg-cyan-500/20"><MessageCircle size={18} /></button>
                          <button onClick={() => startCall(false)} className="p-2 bg-cyan-500/10 text-cyan-400 rounded-xl hover:bg-cyan-500/20"><Phone size={18} /></button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {activeTab === 'calls' && (
              <div className="flex-1 flex flex-col items-center justify-center p-6 opacity-30">
                <Phone size={64} className="mb-4" />
                <p className="text-xs font-bold uppercase tracking-widest">Call history coming soon</p>
              </div>
            )}
          </div>
        ) : (
          /* Call Interface */
          <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6 py-8 relative overflow-hidden">
            <div className="absolute inset-0 z-0">
              <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"></div>
            </div>

            <div className="relative z-10 flex flex-col items-center gap-8 w-full">
              {!isVideoCall && (
                <div className="call-wave">
                  <div className="w-44 h-44 rounded-[40px] overflow-hidden border-4 border-cyan-400 active-indicator shadow-2xl relative rotate-6">
                    <div className="w-full h-full bg-gradient-to-br from-cyan-900 to-slate-900 flex items-center justify-center -rotate-6">
                      <Droplets size={80} className="text-cyan-400" />
                    </div>
                  </div>
                </div>
              )}

              <div className="call-wave text-center">
                <h2 className="text-4xl font-black text-white mb-2 tracking-tighter uppercase">{isVideoCall ? 'Video Splash' : 'Voice Splash'}</h2>
                <p className="text-4xl font-black text-cyan-400 mt-4 font-mono tracking-[0.2em] shadow-cyan-500/20 drop-shadow-lg">
                  {formatCallDuration(callDuration)}
                </p>
              </div>

              {isVideoCall && (
                <div className="w-40 aspect-video rounded-3xl overflow-hidden border-2 border-cyan-400 shadow-2xl bg-slate-900 relative">
                  <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                  <div className="absolute bottom-2 right-2 bg-cyan-500 text-[8px] font-black px-2 py-1 rounded-full text-white">YOU</div>
                </div>
              )}

              <div className="call-wave flex gap-6 mt-8">
                <button className="p-5 rounded-full bg-slate-900/80 hover:bg-cyan-500/20 text-slate-300 transition-all hover:scale-110 border border-cyan-900/30">
                  <Mic size={28} />
                </button>
                <button className="p-6 rounded-full bg-red-600 hover:bg-red-500 text-white transition-all font-bold hover:scale-110 shadow-2xl shadow-red-600/40" onClick={endCall}>
                  <PhoneOff size={32} />
                </button>
                <button className="p-5 rounded-full bg-slate-900/80 hover:bg-cyan-500/20 text-slate-300 transition-all hover:scale-110 border border-cyan-900/30">
                  <MoreVertical size={28} />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="glass-effect border-t border-cyan-900/30 px-6 py-4 flex justify-around text-[10px] font-black tracking-widest uppercase text-slate-500 z-20">
          <button className={`py-2 px-4 rounded-xl transition-all ${activeTab === 'chat' ? 'text-cyan-400 bg-cyan-500/10' : 'hover:text-slate-300'}`} onClick={() => setActiveTab('chat')}>Messages</button>
          <button className={`py-2 px-4 rounded-xl transition-all ${activeTab === 'calls' ? 'text-cyan-400 bg-cyan-500/10' : 'hover:text-slate-300'}`} onClick={() => setActiveTab('calls')}>Calls</button>
          <button className={`py-2 px-4 rounded-xl transition-all ${activeTab === 'contacts' ? 'text-cyan-400 bg-cyan-500/10' : 'hover:text-slate-300'}`} onClick={() => setActiveTab('contacts')}>Contacts</button>
        </div>
      </div>
    </div>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <DOLOR_CHAT />
    </ErrorBoundary>
  );
}
