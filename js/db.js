// Shared data for the page: places friends add, and the confirmed final route.
//
// Three backends with the same interface:
//   firebase — the real shared database (needs firebase-config.js filled in)
//   local    — for testing on localhost; saves to this browser only
//   readonly — deployed site before Firebase is set up; nothing can be edited
//
// Interface: mode, onAuth(cb), signIn(), signOut(), onPlaces(cb, onErr),
//            addPlace(data), deletePlace(id), onFinal(cb, onErr), saveFinal(plan), clearFinal()

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

export async function createDB(mode, config) {
  if (mode === 'firebase') return firebaseDB(config);
  if (mode === 'local') return localDB();
  return readonlyDB();
}

function readonlyDB() {
  const nope = () => Promise.reject(new Error('编辑功能还没开启'));
  return {
    mode: 'readonly',
    onAuth: cb => cb({ user: null, canEdit: false }),
    signIn: nope, signOut: nope,
    onPlaces: cb => cb([]),
    addPlace: nope, deletePlace: nope,
    onFinal: cb => cb(null),
    saveFinal: nope, clearFinal: nope,
  };
}

function localDB() {
  const mem = {};
  const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return mem[k] ?? null; } };
  const write = (k, v) => { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* memory only */ } };
  const user = { name: '本机测试', email: 'local' };
  const placeCbs = [], finalCbs = [];
  const places = () => read('trip.local.places') || [];
  const emitPlaces = () => placeCbs.forEach(cb => cb(places()));
  const emitFinal = () => finalCbs.forEach(cb => cb(read('trip.local.final')));
  return {
    mode: 'local',
    onAuth: cb => cb({ user, canEdit: true }),
    signIn: async () => {}, signOut: async () => {},
    onPlaces: cb => { placeCbs.push(cb); cb(places()); },
    addPlace: async data => {
      const p = { ...data, id: 'L' + Date.now().toString(36), createdBy: user.email, createdByName: user.name, createdAt: Date.now() };
      write('trip.local.places', [...places(), p]);
      emitPlaces();
    },
    deletePlace: async id => { write('trip.local.places', places().filter(p => p.id !== id)); emitPlaces(); },
    onFinal: cb => { finalCbs.push(cb); cb(read('trip.local.final')); },
    saveFinal: async plan => { write('trip.local.final', { ...plan, updatedBy: user.email, updatedByName: user.name, updatedAt: Date.now() }); emitFinal(); },
    clearFinal: async () => { write('trip.local.final', null); emitFinal(); },
  };
}

async function firebaseDB(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  let state = { user: null, canEdit: false };
  const authCbs = [];

  A.onAuthStateChanged(auth, async u => {
    let canEdit = false;
    if (u && u.email) {
      // The editors collection is managed by hand in the Firebase console: one document per allowed email.
      try { canEdit = (await F.getDoc(F.doc(db, 'editors', u.email.toLowerCase()))).exists(); } catch { canEdit = false; }
    }
    state = { user: u && { name: u.displayName || u.email, email: u.email.toLowerCase(), photo: u.photoURL }, canEdit };
    authCbs.forEach(cb => cb(state));
  });

  const provider = new A.GoogleAuthProvider();
  return {
    mode: 'firebase',
    onAuth: cb => { authCbs.push(cb); cb(state); },
    signIn: async () => {
      try { await A.signInWithPopup(auth, provider); } catch (e) {
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') await A.signInWithRedirect(auth, provider);
        else throw e;
      }
    },
    signOut: () => A.signOut(auth),
    onPlaces: (cb, onErr) => F.onSnapshot(F.collection(db, 'places'),
      snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))), onErr),
    addPlace: data => F.addDoc(F.collection(db, 'places'), {
      ...data, createdBy: state.user.email, createdByName: state.user.name, createdAt: F.serverTimestamp(),
    }),
    deletePlace: id => F.deleteDoc(F.doc(db, 'places', id)),
    onFinal: (cb, onErr) => F.onSnapshot(F.doc(db, 'plans', 'final'), snap => cb(snap.exists() ? snap.data() : null), onErr),
    saveFinal: plan => F.setDoc(F.doc(db, 'plans', 'final'), {
      ...plan, updatedBy: state.user.email, updatedByName: state.user.name, updatedAt: F.serverTimestamp(),
    }),
    clearFinal: () => F.deleteDoc(F.doc(db, 'plans', 'final')),
  };
}
