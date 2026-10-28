// Mode en ligne : connexion directe entre navigateurs (WebRTC, via PeerJS).
// L’hôte fait tourner la partie ; les invités envoient leurs actions et reçoivent l’état.
// Avec « ?transport=local » dans l’adresse, un transport BroadcastChannel remplace
// PeerJS : plusieurs onglets du même navigateur jouent ensemble (utile pour tester).

const PEERJS_URLS = [
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
];
const PREFIX = 'chadpoly-v1-';
const PING_MS = 4000;
const TIMEOUT_MS = 15000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans I, L, O, 0, 1

export function newCode() {
  return Array.from(crypto.getRandomValues(new Uint32Array(5)), (n) => ALPHABET[n % ALPHABET.length]).join('');
}
export function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}
export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class NetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const MESSAGES = {
  'peer-unavailable': 'Aucune partie trouvée avec ce code. Vérifiez-le, ou demandez à l’hôte si la partie est toujours ouverte.',
  'unavailable-id': 'Ce code de partie est déjà utilisé.',
  'browser-incompatible': 'Ce navigateur ne permet pas de jouer en ligne. Essayez avec Chrome, Firefox, Edge ou Safari à jour.',
  network: 'Impossible de joindre le serveur de connexion. Vérifiez votre connexion internet.',
  'server-error': 'Le serveur de connexion ne répond pas. Réessayez dans un instant.',
  'socket-error': 'Le serveur de connexion ne répond pas. Réessayez dans un instant.',
  'socket-closed': 'La connexion au serveur a été coupée. Réessayez.',
};
function translate(err) {
  const type = err?.type || err?.code || 'unknown';
  return new NetError(type, MESSAGES[type] || 'La connexion a échoué. Réessayez.');
}

const useLocal = () => new URLSearchParams(location.search).get('transport') === 'local';

// ---------------------------------------------------------------- PeerJS
let peerjsPromise = null;
const peerClass = () => window.Peer || window.peerjs?.Peer || null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = resolve;
    el.onerror = () => { el.remove(); reject(); };
    document.head.appendChild(el);
  });
}

function loadPeerJS() {
  if (peerClass()) return Promise.resolve(peerClass());
  if (!peerjsPromise) {
    peerjsPromise = (async () => {
      for (const url of PEERJS_URLS) {
        try {
          await loadScript(url);
          if (peerClass()) return peerClass();
        } catch { /* source suivante */ }
      }
      peerjsPromise = null;
      throw new NetError('load', 'Impossible de charger le module de jeu en ligne. Vérifiez votre connexion internet.');
    })();
  }
  return peerjsPromise;
}

async function peerHost(code, cb) {
  const Peer = await loadPeerJS();
  return new Promise((resolve, reject) => {
    const peer = new Peer(PREFIX + code, { debug: 0 });
    const conns = new Map();
    let ready = false;
    peer.on('open', () => {
      ready = true;
      resolve({
        sendTo(id, msg) { const c = conns.get(id); if (c && c.open) c.send(msg); },
        kick(id) { const c = conns.get(id); conns.delete(id); c?.close(); },
        close() { peer.destroy(); },
      });
    });
    peer.on('error', (err) => {
      if (!ready) { peer.destroy(); reject(translate(err)); }
      else if (err.type !== 'peer-unavailable') cb.onError(translate(err));
    });
    // Perte du serveur de mise en relation : les parties en cours continuent,
    // on se réenregistre pour que de nouveaux joueurs puissent rejoindre.
    peer.on('disconnected', () => {
      setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
    });
    peer.on('connection', (conn) => {
      const id = conn.connectionId;
      conn.on('open', () => { conns.set(id, conn); cb.onConnect(id); });
      conn.on('data', (msg) => cb.onData(id, msg));
      const gone = () => { if (conns.delete(id)) cb.onClose(id); };
      conn.on('close', gone);
      conn.on('error', gone);
    });
  });
}

async function peerJoin(code, cb) {
  const Peer = await loadPeerJS();
  return new Promise((resolve, reject) => {
    const peer = new Peer({ debug: 0 });
    let settled = false;
    let timer = null;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.destroy();
      reject(e);
    };
    timer = setTimeout(() => fail(new NetError('timeout', 'La connexion à la partie prend trop de temps. Réessayez, ou essayez un autre réseau (certains réseaux bloquent le jeu en ligne).')), 20000);
    peer.on('error', (err) => { if (!settled) fail(translate(err)); });
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      conn.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          send(msg) { if (conn.open) conn.send(msg); },
          close() { peer.destroy(); },
        });
      });
      conn.on('data', (msg) => cb.onData(msg));
      conn.on('close', () => cb.onClose());
      conn.on('error', () => cb.onClose());
    });
  });
}

// ---------------------------------------------------------------- Transport local (tests)
function localHost(code, cb) {
  const ch = new BroadcastChannel(`chadpoly-${code}`);
  const conns = new Set();
  ch.onmessage = ({ data: m }) => {
    if (m.to !== 'host') return;
    if (m.kind === 'connect') {
      conns.add(m.from);
      ch.postMessage({ to: m.from, kind: 'accept' });
      cb.onConnect(m.from);
    } else if (m.kind === 'data' && conns.has(m.from)) {
      cb.onData(m.from, m.data);
    } else if (m.kind === 'close' && conns.delete(m.from)) {
      cb.onClose(m.from);
    }
  };
  return Promise.resolve({
    sendTo(id, msg) { if (conns.has(id)) ch.postMessage({ to: id, kind: 'data', data: msg }); },
    kick(id) { if (conns.delete(id)) ch.postMessage({ to: id, kind: 'close' }); },
    close() { for (const id of conns) ch.postMessage({ to: id, kind: 'close' }); ch.close(); },
  });
}

function localJoin(code, cb) {
  return new Promise((resolve, reject) => {
    const ch = new BroadcastChannel(`chadpoly-${code}`);
    const me = `g${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { ch.close(); reject(new NetError('peer-unavailable', MESSAGES['peer-unavailable'])); }, 2000);
    ch.onmessage = ({ data: m }) => {
      if (m.to !== me) return;
      if (m.kind === 'accept') {
        clearTimeout(timer);
        resolve({
          send(d) { ch.postMessage({ to: 'host', from: me, kind: 'data', data: d }); },
          close() { ch.postMessage({ to: 'host', from: me, kind: 'close' }); ch.close(); },
        });
      } else if (m.kind === 'data') {
        cb.onData(m.data);
      } else if (m.kind === 'close') {
        ch.close();
        cb.onClose();
      }
    };
    ch.postMessage({ to: 'host', from: me, kind: 'connect' });
  });
}

// ---------------------------------------------------------------- API publique
/**
 * Ouvre une partie. h = { onMessage(id, msg), onDisconnect(id), onError(err) }
 * @returns {{ sendTo(id,msg), kick(id), close() }}
 */
export async function host(code, h) {
  const seen = new Map(); // id -> dernier signe de vie
  const cb = {
    onConnect: (id) => { seen.set(id, Date.now()); },
    onData: (id, msg) => {
      if (!seen.has(id)) return;
      seen.set(id, Date.now());
      if (msg && (msg.t === '_ping' || msg.t === '_pong')) return;
      h.onMessage(id, msg);
    },
    onClose: (id) => { if (seen.delete(id)) h.onDisconnect(id); },
    onError: (e) => h.onError?.(e),
  };
  const raw = useLocal() ? await localHost(code, cb) : await peerHost(code, cb);
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, t] of seen) {
      if (now - t > TIMEOUT_MS) { seen.delete(id); raw.kick(id); h.onDisconnect(id); }
      else raw.sendTo(id, { t: '_ping' });
    }
  }, PING_MS);
  return {
    sendTo: (id, msg) => raw.sendTo(id, msg),
    // Un renvoi décidé par l’hôte ne déclenche pas onDisconnect
    kick: (id) => { seen.delete(id); raw.kick(id); },
    close: () => { clearInterval(timer); raw.close(); },
  };
}

/**
 * Rejoint une partie. h = { onMessage(msg), onClose() }
 * @returns {{ send(msg), close() }}
 */
export async function join(code, h) {
  let raw = null;
  let last = Date.now();
  let closed = false;
  let timer = null;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    h.onClose();
  };
  const cb = {
    onData: (msg) => {
      last = Date.now();
      if (msg && msg.t === '_ping') { raw?.send({ t: '_pong' }); return; }
      if (!closed) h.onMessage(msg);
    },
    onClose: finish,
  };
  raw = useLocal() ? await localJoin(code, cb) : await peerJoin(code, cb);
  timer = setInterval(() => {
    if (Date.now() - last > TIMEOUT_MS) { raw.close(); finish(); }
  }, PING_MS);
  return {
    send: (msg) => { if (!closed) raw.send(msg); },
    close: () => { closed = true; clearInterval(timer); raw.close(); },
  };
}
