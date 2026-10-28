// Interface : rendu du plateau, actions des joueurs, boucle des bots, mode en ligne.
import { Game } from './game.js';
import { botStep, botAcceptsTrade } from './bot.js';
import { BOARD, GROUPS, PLAYER_COLORS, JAIL_FINE } from './data.js';
import * as Net from './net.js';

const SAVE_KEY = 'chadpoly.save.v1';
const GUEST_KEY = 'chadpoly.guest.v1';
const NAME_KEY = 'chadpoly.name.v1';
const BOT_NAMES = ['Margaux', 'Hugo', 'Inès', 'Malik', 'Chloé', 'Théo'];
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = (n) => `${Math.round(n).toLocaleString('fr-FR')} €`;
const DARK_GROUPS = new Set(['brun', 'rose', 'rouge', 'vert', 'marine']);

let game = null;
let botDelay = 450;
let botTimer = null;
let prevPositions = [];
let openPropIdx = null;
let awaitingTrade = null; // { logLen } : réponse attendue d’un bot à notre offre

// État du mode en ligne
const online = {
  mode: 'local',       // 'local' | 'host' | 'guest'
  code: null,
  myName: '',
  myId: null,          // joueur contrôlé par cet appareil
  net: null,
  slots: [],           // salon : [{ name, isBot, connId }]
  myIndex: null,       // invité : sa place dans le salon
  started: false,
  conns: new Map(),    // hôte : connId -> id joueur
  tokens: {},          // hôte : id joueur -> jeton de reconnexion
  connectedIds: [],    // invité : joueurs connectés (reçu de l’hôte)
  maxTurns: 0,
  status: 'idle',      // 'idle' | 'connecting' | 'lobby' | 'playing' | 'lost' | 'ended'
  error: '',
  retryTimer: null,
};

// ---------------------------------------------------------------- Stockage (tolérant aux erreurs)
// Les parties en ligne sont mémorisées par onglet (sessionStorage) : deux onglets
// du même navigateur peuvent ainsi être l’un hôte, l’autre invité.
const ONLINE_SAVE_KEY = 'chadpoly.online.v1';
const TAB_KEYS = new Set([ONLINE_SAVE_KEY, 'chadpoly.guest.v1']);
function area(key) { return TAB_KEYS.has(key) ? sessionStorage : localStorage; }
function store(key, value) {
  try {
    if (value === null) area(key).removeItem(key);
    else area(key).setItem(key, JSON.stringify(value));
  } catch { /* stockage indisponible */ }
}
function read(key) {
  try { return JSON.parse(area(key).getItem(key)); } catch { return null; }
}

// ---------------------------------------------------------------- Plateau
function gridPos(i) {
  if (i <= 10) return [11, 11 - i];
  if (i < 20) return [11 - (i - 10), 1];
  if (i <= 30) return [1, i - 19];
  return [i - 29, 11];
}
function side(i) {
  if (i % 10 === 0) return 'corner';
  if (i < 10) return 'bottom';
  if (i < 20) return 'left';
  if (i < 30) return 'top';
  return 'right';
}

const ICONS = { station: '🚆', chance: '?', chest: '✉', tax: '€' };
const CORNERS = {
  go: { icon: '⟵', label: 'Départ', sub: '+200 €' },
  jail: { icon: '▦', label: 'Prison', sub: 'Simple visite' },
  parking: { icon: '⛲', label: 'Parc gratuit', sub: '' },
  gotojail: { icon: '➜', label: 'Allez en prison', sub: '' },
};

function buildBoard() {
  const board = $('#board');
  BOARD.forEach((def, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `sq ${side(i)}`;
    el.dataset.idx = i;
    const [r, c] = gridPos(i);
    el.style.gridRow = r;
    el.style.gridColumn = c;
    el.setAttribute('aria-label', def.name);
    el.addEventListener('click', () => openProperty(i));
    board.appendChild(el);
  });
}

function houseMarkup(n) {
  if (n === 5) return '<span class="hotel" title="Hôtel"></span>';
  return '<span class="house"></span>'.repeat(n);
}

function renderSquare(i) {
  const el = document.querySelector(`.sq[data-idx="${i}"]`);
  const def = BOARD[i];
  const sq = game.squares[i];
  let html = '';
  if (def.type in CORNERS) {
    const c = CORNERS[def.type];
    html = `<span class="icon">${c.icon}</span><span>${c.label}</span><small>${c.sub}</small>`;
  } else if (def.type === 'property') {
    html = `<span class="band" style="background:${GROUPS[def.group].color}">${houseMarkup(sq.houses)}</span>
      <span class="body"><span class="name">${esc(def.name)}</span><span class="price">${def.price} €</span></span>`;
  } else {
    const icon = def.icon || ICONS[def.type] || '';
    const price = def.price ? `${def.price} €` : def.amount ? `Payez ${def.amount} €` : '';
    html = `<span class="body"><span class="name">${esc(def.name)}</span><span class="icon">${icon}</span><span class="price">${price}</span></span>`;
  }
  if (sq.owner !== null) {
    html += `<span class="owner" style="--owner:${game.players[sq.owner].color}"></span>`;
  }
  const here = game.players.filter((p) => !p.bankrupt && p.pos === i);
  if (here.length) {
    html += `<span class="tokens">${here.map((p) => {
      const moved = prevPositions[p.id] !== undefined && prevPositions[p.id] !== p.pos;
      return `<span class="token${moved ? ' active' : ''}" style="--c:${p.color}" title="${esc(p.name)}">${esc(p.name[0].toUpperCase())}</span>`;
    }).join('')}</span>`;
  }
  el.innerHTML = html;
  el.classList.toggle('mortgaged', sq.mortgaged);
  const ownerName = sq.owner !== null ? `, propriété de ${game.players[sq.owner].name}` : '';
  el.setAttribute('aria-label', `${def.name}${ownerName}`);
}

// ---------------------------------------------------------------- Rendu général
const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
function renderDice(animate) {
  const dice = $('#dice');
  [...dice.children].forEach((d, k) => {
    const v = game.dice[k] || 1;
    d.innerHTML = Array.from({ length: 9 }, (_, n) => (PIPS[v].includes(n + 1) ? '<i></i>' : '<span></span>')).join('');
  });
  dice.setAttribute('aria-label', game.dice[0] ? `Dés : ${game.dice[0]} et ${game.dice[1]}` : 'Dés');
  if (animate) {
    dice.classList.remove('rolling');
    void dice.offsetWidth;
    dice.classList.add('rolling');
  }
}

function render({ rolled = false } = {}) {
  if (!game) return;
  for (let i = 0; i < 40; i++) renderSquare(i);
  prevPositions = game.players.map((p) => p.pos);
  renderDice(rolled);
  renderCenter();
  renderPlayers();
  renderLog();
  renderNetInfo();
  if (openPropIdx !== null && $('#propDialog').open) renderPropDialog(openPropIdx);
  checkTradeAnswer();
  renderIncomingOffer();
}

const isOnline = () => online.mode !== 'local';
const isMe = (pid) => isOnline() && pid === online.myId;

/** Cet appareil peut-il agir pour le joueur dont c’est le tour ? */
function canAct() {
  if (!game || game.phase === 'gameover' || game.player.isBot) return false;
  if (!isOnline()) return true;
  return game.current === online.myId && !!online.net && online.status !== 'lost';
}

function connectedIds() {
  if (online.mode === 'host') return [online.myId, ...online.conns.values()];
  if (online.mode === 'guest') return online.connectedIds;
  return [];
}
function isDisconnected(p) {
  return online.started && p.remote && !p.bankrupt && !connectedIds().includes(p.id);
}

function renderCenter() {
  const p = game.player;
  const info = $('#turnInfo');
  const msg = $('#message');
  const actions = $('#actions');
  actions.innerHTML = '';

  if (game.phase === 'gameover') {
    const w = game.players[game.winner];
    info.innerHTML = `Tour ${game.turn}`;
    msg.innerHTML = `<p class="winner-title">🏆 ${isMe(w.id) ? 'Vous gagnez la partie' : `${esc(w.name)} gagne la partie`}</p>
      <p>Patrimoine final : ${euro(game.netWorth(w.id))}</p>`;
    addBtn('Nouvelle partie', () => openSetup(), 'primary');
    return;
  }

  const who = isMe(p.id) ? 'Vous jouez' : `<span class="who">${esc(p.name)}</span>${p.isBot ? ' (ordinateur)' : ''} joue`;
  info.innerHTML = `Tour ${game.turn} : <span class="chip" style="--c:${p.color}"></span>${isMe(p.id) ? `<span class="who">${who}</span>` : who}`;

  // Message
  let m = '';
  if (game.pendingOffer) {
    const to = game.players[game.pendingOffer.to];
    m = `<p>${isMe(to.id) ? 'Vous devez' : `${esc(to.name)} doit`} répondre à une proposition d’échange.</p>`;
  } else if (p.money < 0) {
    m = `<p class="warn">Il manque ${euro(-p.money)} à ${esc(p.name)}.</p>
      ${canAct() ? '<p>Vendez des bâtiments ou hypothéquez depuis les fiches de vos propriétés (cliquez sur une case), ou déclarez faillite.</p>' : ''}`;
  } else if (game.lastCard && game.phase !== 'roll') {
    const deck = game.lastCard.deck;
    m = `<div class="card ${deck}"><b>${deck === 'chance' ? 'Chance' : 'Caisse commune'}</b>${esc(game.lastCard.text)}</div>`;
  } else if (game.phase === 'decide') {
    const def = BOARD[game.pending.idx];
    m = `<p><strong>${esc(def.name)}</strong> est libre. Prix : ${euro(def.price)}.</p>`;
  } else if (p.inJail && game.phase === 'roll') {
    m = `<p>${esc(p.name)} est en prison (essai ${p.jailTurns + 1} sur 3).</p>`;
  } else {
    const last = game.log[game.log.length - 1];
    m = last ? `<p>${esc(last.msg)}</p>` : '';
  }
  if (game.phase === 'decide' && game.lastCard) {
    const def = BOARD[game.pending.idx];
    m += `<p><strong>${esc(def.name)}</strong> est libre. Prix : ${euro(def.price)}.</p>`;
  }
  if (!game.pendingOffer) {
    if (p.isBot) m += `<p class="pmeta">${esc(p.name)} réfléchit…</p>`;
    else if (!canAct()) m += `<p class="pmeta">En attente de ${esc(p.name)}${isDisconnected(p) ? ', qui s’est déconnecté' : ''}…</p>`;
  }
  msg.innerHTML = m;

  if (!canAct()) return;

  // Actions du joueur
  if (game.phase === 'roll') {
    if (p.inJail && !game.pendingOffer) {
      if (p.jailCards > 0) addBtn('Utiliser la carte prison', () => perform('useJailCard'));
      addBtn(`Payer ${JAIL_FINE} €`, () => perform('payJailFine'), '', p.money < JAIL_FINE);
    }
    addBtn(p.inJail ? 'Tenter un double' : 'Lancer les dés', () => perform('roll'), 'primary', !game.canRoll());
  } else if (game.phase === 'decide') {
    const def = BOARD[game.pending.idx];
    addBtn(`Acheter pour ${euro(def.price)}`, () => perform('buy'), 'primary', p.money < def.price);
    addBtn('Ne pas acheter', () => perform('decline'));
  } else if (game.phase === 'action') {
    addBtn('Terminer le tour', () => perform('endTurn'), 'primary', !game.canEndTurn());
  }
  if (game.phase !== 'decide' && !game.pendingOffer) addBtn('Échanger', openTrade);
  if (p.money < 0) addBtn('Déclarer faillite', confirmBankruptcy, 'danger');
}

function addBtn(label, onClick, kind = '', disabled = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${kind}`;
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  $('#actions').appendChild(b);
}

function renderPlayers() {
  $('#players').innerHTML = game.players.map((p) => {
    const owned = game.ownedBy(p.id);
    const chips = owned.map((i) => {
      const d = BOARD[i];
      const color = d.group ? GROUPS[d.group].color : '#fff';
      const label = d.type === 'station' ? '🚆' : d.icon || '';
      return `<button type="button" class="prop-chip${game.squares[i].mortgaged ? ' mortgaged' : ''}" style="--g:${color}" data-idx="${i}" title="${esc(d.name)}" aria-label="${esc(d.name)}">${label}</button>`;
    }).join('');
    const status = [];
    const away = isDisconnected(p);
    if (p.isBot) status.push(p.remote ? 'joué par l’ordinateur' : 'ordinateur');
    if (away) status.push('déconnecté');
    if (p.inJail) status.push('en prison');
    if (p.jailCards) status.push(`${p.jailCards} carte${p.jailCards > 1 ? 's' : ''} prison`);
    if (p.bankrupt) status.push('en faillite');
    const takeOver = online.mode === 'host' && away && !p.isBot && game.phase !== 'gameover'
      ? `<button type="button" class="btn small" data-botify="${p.id}">Faire jouer l’ordinateur</button>` : '';
    return `<article class="player${p.id === game.current && game.phase !== 'gameover' ? ' current' : ''}${p.bankrupt ? ' bankrupt' : ''}" style="--c:${p.color}">
      <div class="player-top"><span class="pname">${esc(p.name)}${isMe(p.id) ? ' <span class="you-tag">(vous)</span>' : ''}</span><span class="pmoney${p.money < 0 ? ' neg' : ''}">${euro(p.money)}</span></div>
      <div class="pmeta">Patrimoine ${euro(game.netWorth(p.id))}${status.length ? `, ${status.join(', ')}` : ''}</div>
      ${chips ? `<div class="props">${chips}</div>` : ''}
      ${takeOver}
    </article>`;
  }).join('');
  document.querySelectorAll('.prop-chip').forEach((b) => b.addEventListener('click', () => openProperty(+b.dataset.idx)));
  document.querySelectorAll('[data-botify]').forEach((b) => b.addEventListener('click', () => botify(+b.dataset.botify)));
}

function renderLog() {
  const items = game.log.slice(-120).reverse();
  $('#log').innerHTML = items.map((e) => `<li class="${e.msg.startsWith('—') ? 'turn-sep' : ''}">${esc(e.msg)}</li>`).join('');
}

function renderNetInfo() {
  const el = $('#netInfo');
  if (!isOnline() || !online.code) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `En ligne, partie ${online.code}${online.mode === 'host' ? ' (vous êtes l’hôte)' : ''}`;
}

// ---------------------------------------------------------------- Actions
const ACTIONS = {
  roll: (g) => g.roll(),
  buy: (g) => g.buy(),
  decline: (g) => g.decline(),
  payJailFine: (g) => g.payJailFine(),
  useJailCard: (g) => g.useJailCard(),
  endTurn: (g) => g.endTurn(),
  build: (g, i) => g.build(i),
  sellBuilding: (g, i) => g.sellBuilding(i),
  mortgage: (g, i) => g.mortgage(i),
  unmortgage: (g, i) => g.unmortgage(i),
  bankrupt: (g) => g.declareBankruptcy(g.debtor?.id),
  proposeTrade: (g, o) => g.proposeTrade(o),
  respondTrade: (g, yes) => g.respondTrade(!!yes),
  tradeBot: (g, o) => {
    if (botAcceptsTrade(g, o, o.to)) g.executeTrade(o);
    else g.addLog(`❌ ${g.players[o.to].name} refuse l’échange proposé par ${g.players[o.from].name}.`);
  },
};

/** L’hôte vérifie qu’un joueur a le droit de faire cette action. */
function isAllowed(pid, name, args) {
  if (!game || game.phase === 'gameover' || !Object.hasOwn(ACTIONS, name)) return false;
  if (name === 'respondTrade') return game.pendingOffer?.to === pid;
  if (pid !== game.current || game.player.isBot) return false;
  if (name === 'proposeTrade' || name === 'tradeBot') {
    const o = args[0];
    if (!o || o.from !== pid || !game.players[o.to]) return false;
    if ((name === 'tradeBot') !== game.players[o.to].isBot) return false;
  }
  return true;
}

function perform(name, ...args) {
  if (!game) return;
  if (online.mode === 'guest') {
    online.net?.send({ t: 'action', name, args });
    return;
  }
  applyAction(online.mode === 'host' ? online.myId : null, name, args);
}

function applyAction(pid, name, args) {
  if (pid !== null && !isAllowed(pid, name, args)) return;
  try {
    ACTIONS[name](game, ...args);
  } catch (err) {
    console.warn(err);
  }
  afterChange(name === 'roll');
}

function afterChange(rolled = false) {
  save();
  if (online.mode === 'host') broadcastState(rolled);
  render({ rolled });
  scheduleBot();
}

function confirmBankruptcy() {
  const p = game.player;
  const assets = game.liquidationValue(p.id) - p.money;
  const text = assets > -p.money
    ? `Vous pourriez encore réunir environ ${euro(assets)} en vendant et hypothéquant. Déclarer faillite quand même ?`
    : 'Déclarer faillite ? Vous quitterez la partie.';
  if (window.confirm(text)) perform('bankrupt');
}

function scheduleBot() {
  clearTimeout(botTimer);
  if (!game || online.mode === 'guest' || game.phase === 'gameover' || game.pendingOffer || !game.player.isBot) return;
  botTimer = setTimeout(() => {
    const before = game.log.length;
    try {
      botStep(game);
    } catch (err) {
      console.error('Erreur du bot', err);
      if (game.canEndTurn()) game.endTurn();
    }
    const rolled = game.log.slice(before).some((e) => / lance \d/.test(e.msg));
    afterChange(rolled);
  }, botDelay);
}

// ---------------------------------------------------------------- Fiche de propriété
function openProperty(i) {
  if (!game) return;
  openPropIdx = i;
  renderPropDialog(i);
  const dlg = $('#propDialog');
  if (!dlg.open) dlg.showModal();
}

function renderPropDialog(i) {
  const def = BOARD[i];
  const sq = game.squares[i];
  const owner = sq.owner !== null ? game.players[sq.owner] : null;
  let body = '';

  if (def.type === 'property') {
    const g = GROUPS[def.group];
    const mono = owner && game.hasMonopoly(owner.id, def.group);
    const rows = [
      ['Terrain nu', def.rents[0], sq.houses === 0 && !mono],
      ['Couleur complète', def.rents[0] * 2, sq.houses === 0 && mono],
      ['1 maison', def.rents[1], sq.houses === 1],
      ['2 maisons', def.rents[2], sq.houses === 2],
      ['3 maisons', def.rents[3], sq.houses === 3],
      ['4 maisons', def.rents[4], sq.houses === 4],
      ['Hôtel', def.rents[5], sq.houses === 5],
    ];
    body = `<div class="deed">
      <div class="deed-head${DARK_GROUPS.has(def.group) ? ' dark' : ''}" style="--g:${g.color}"><small>Titre de propriété</small><h3>${esc(def.name)}</h3></div>
      <table>${rows.map(([l, v, now]) => `<tr${now && owner ? ' class="now"' : ''}><td>${l}</td><td>${euro(v)}</td></tr>`).join('')}</table>
      <div class="foot">Maison ou hôtel : ${euro(g.houseCost)} chacun. Hypothèque : ${euro(def.price / 2)}.</div>
    </div>`;
  } else if (def.type === 'station') {
    const n = owner ? game.countOwned(owner.id, 'station') : 0;
    body = `<div class="deed"><div class="deed-head"><small>Gare</small><h3>🚆 ${esc(def.name)}</h3></div>
      <table>${[1, 2, 3, 4].map((k) => `<tr${k === n ? ' class="now"' : ''}><td>${k} gare${k > 1 ? 's' : ''} possédée${k > 1 ? 's' : ''}</td><td>${euro(25 * 2 ** (k - 1))}</td></tr>`).join('')}</table>
      <div class="foot">Hypothèque : ${euro(def.price / 2)}.</div></div>`;
  } else if (def.type === 'utility') {
    const n = owner ? game.countOwned(owner.id, 'utility') : 0;
    body = `<div class="deed"><div class="deed-head"><small>Compagnie</small><h3>${def.icon} ${esc(def.name)}</h3></div>
      <table><tr${n === 1 ? ' class="now"' : ''}><td>Une compagnie</td><td>4 × les dés</td></tr>
      <tr${n === 2 ? ' class="now"' : ''}><td>Les deux compagnies</td><td>10 × les dés</td></tr></table>
      <div class="foot">Hypothèque : ${euro(def.price / 2)}.</div></div>`;
  } else {
    const texts = {
      go: 'Recevez 200 € à chaque passage.',
      jail: 'Si vous y êtes envoyé : faites un double, payez 50 € ou utilisez une carte pour sortir. Sinon, simple visite.',
      parking: 'Rien ne se passe ici : profitez de la pause.',
      gotojail: 'Allez directement en prison, sans passer par la case Départ.',
      chance: 'Piochez une carte Chance.',
      chest: 'Piochez une carte Caisse commune.',
      tax: `Payez ${euro(def.amount || 0)} à la banque.`,
    };
    body = `<h2 class="dialog-title">${esc(def.name)}</h2><p>${texts[def.type] || ''}</p>`;
  }

  let ownerLine = '';
  if (def.price) {
    ownerLine = owner
      ? `<p class="hint" style="margin-top:12px">Propriétaire : <strong>${isMe(owner.id) ? 'vous' : esc(owner.name)}</strong>${sq.mortgaged ? ', hypothéquée' : ''}. Loyer actuel : ${def.type === 'utility' ? 'selon les dés' : euro(game.rentFor(i))}.</p>`
      : `<p class="hint" style="margin-top:12px">À vendre : ${euro(def.price)}.</p>`;
  }

  $('#propContent').innerHTML = `${body}${ownerLine}<div class="dialog-actions" id="propActions"></div>`;
  const box = $('#propActions');
  const add = (label, name, disabled = false, kind = '') => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `btn ${kind}`; b.textContent = label; b.disabled = disabled;
    b.addEventListener('click', () => perform(name, i));
    box.appendChild(b);
  };

  // Gestion : uniquement le joueur dont c’est le tour, sur son appareil
  if (owner && owner.id === game.current && canAct()) {
    const g = def.group ? GROUPS[def.group] : null;
    if (game.canBuild(i)) add(sq.houses === 4 ? `Construire un hôtel (${euro(g.houseCost)})` : `Construire une maison (${euro(g.houseCost)})`, 'build', false, 'primary');
    if (game.canSellBuilding(i)) add(`Vendre ${sq.houses === 5 ? 'l’hôtel' : 'une maison'} (+${euro(g.houseCost / 2)})`, 'sellBuilding');
    if (game.canMortgage(i)) add(`Hypothéquer (+${euro(def.price / 2)})`, 'mortgage');
    if (sq.mortgaged) add(`Lever l’hypothèque (${euro(game.unmortgageCost(i))})`, 'unmortgage', !game.canUnmortgage(i));
    if (def.type === 'property' && !game.hasMonopoly(owner.id, def.group)) {
      box.insertAdjacentHTML('afterbegin', '<p class="hint" style="margin:0;flex-basis:100%">Possédez toute la couleur pour construire.</p>');
    }
  }
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'btn ghost'; close.textContent = 'Fermer';
  close.addEventListener('click', () => $('#propDialog').close());
  box.appendChild(close);
}

// ---------------------------------------------------------------- Échanges
function propLabel(i) {
  const d = BOARD[i];
  const color = d.group ? GROUPS[d.group].color : '#fff';
  return `<span class="sw" style="--g:${color}"></span>${esc(d.name)}${game.squares[i].mortgaged ? ' (hyp.)' : ''}`;
}

function openTrade() {
  const me = game.player;
  const others = game.activePlayers.filter((p) => p.id !== me.id);
  if (!others.length) return;
  const content = $('#tradeContent');
  awaitingTrade = null;

  const draw = (partnerId) => {
    const partner = game.players[partnerId];
    const list = (pid, name) => {
      const items = game.ownedBy(pid).filter((i) => game.isTradable(i, pid));
      return items.length
        ? items.map((i) => `<label><input type="checkbox" name="${name}" value="${i}">${propLabel(i)}</label>`).join('')
        : '<span class="empty">Aucune propriété échangeable</span>';
    };
    content.innerHTML = `
      <h2 class="dialog-title">Proposer un échange</h2>
      <label class="field"><span>Avec</span>
        <select id="tradePartner">${others.map((p) => `<option value="${p.id}"${p.id === partnerId ? ' selected' : ''}>${esc(p.name)}${p.isBot ? ' (ordinateur)' : ''}</option>`).join('')}</select>
      </label>
      <div class="trade-cols">
        <div class="trade-col"><h3>Vous donnez</h3>
          <div class="trade-list">${list(me.id, 'give')}</div>
          <label class="field"><span>Argent (vous avez ${euro(me.money)})</span><input type="number" id="moneyGive" min="0" max="${Math.max(0, me.money)}" step="10" value="0"></label>
        </div>
        <div class="trade-col"><h3>Vous recevez de ${esc(partner.name)}</h3>
          <div class="trade-list">${list(partner.id, 'get')}</div>
          <label class="field"><span>Argent (${esc(partner.name)} a ${euro(partner.money)})</span><input type="number" id="moneyGet" min="0" max="${Math.max(0, partner.money)}" step="10" value="0"></label>
        </div>
      </div>
      <p class="trade-error" id="tradeError" role="alert"></p>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" id="tradeCancel">Annuler</button>
        <button type="button" class="btn primary" id="tradeSend">Proposer l’échange</button>
      </div>`;
    $('#tradePartner').addEventListener('change', (e) => draw(+e.target.value));
    $('#tradeCancel').addEventListener('click', () => { awaitingTrade = null; $('#tradeDialog').close(); });
    $('#tradeSend').addEventListener('click', () => sendTrade(partner));
  };

  draw(others[0].id);
  $('#tradeDialog').showModal();
}

function sendTrade(partner) {
  const me = game.player;
  const checked = (name) => [...document.querySelectorAll(`#tradeContent input[name="${name}"]:checked`)].map((c) => +c.value);
  const offer = {
    from: me.id,
    to: partner.id,
    give: checked('give'),
    get: checked('get'),
    moneyGive: Math.max(0, Math.floor(+$('#moneyGive').value || 0)),
    moneyGet: Math.max(0, Math.floor(+$('#moneyGet').value || 0)),
  };
  const err = game.validateTrade(offer);
  if (err) { $('#tradeError').textContent = err; return; }

  if (partner.isBot) {
    // La réponse arrive avec le prochain état (immédiatement hors ligne)
    awaitingTrade = { logLen: game.log.length, partner: partner.name };
    $('#tradeError').textContent = '';
    $('#tradeSend').disabled = true;
    perform('tradeBot', offer);
  } else {
    $('#tradeDialog').close();
    perform('proposeTrade', offer);
  }
}

/** Affiche la réponse d’un bot à notre proposition. */
function checkTradeAnswer() {
  if (!awaitingTrade || game.log.length === awaitingTrade.logLen) return;
  const fresh = game.log.slice(awaitingTrade.logLen).map((e) => e.msg);
  const partner = awaitingTrade.partner;
  awaitingTrade = null;
  if (!$('#tradeDialog').open) return;
  if (fresh.some((m) => m.startsWith('🤝'))) {
    $('#tradeDialog').close();
  } else if (fresh.some((m) => m.startsWith('❌'))) {
    const errEl = $('#tradeError');
    if (errEl) errEl.textContent = `${partner} refuse. Essayez d’ajouter de l’argent ou une autre propriété.`;
    const send = $('#tradeSend');
    if (send) send.disabled = false;
  }
}

/** Offre en attente vers un humain : on lui pose la question sur son appareil. */
function renderIncomingOffer() {
  const o = game.pendingOffer;
  const dlg = $('#tradeDialog');
  if (!o) {
    if (dlg.open && dlg.dataset.offer) { dlg.close(); delete dlg.dataset.offer; }
    return;
  }
  const to = game.players[o.to];
  const from = game.players[o.from];
  if (to.isBot) { // sécurité : une offre vers un bot est tranchée tout de suite par l’hôte
    if (online.mode !== 'guest') {
      game.respondTrade(botAcceptsTrade(game, o, to.id));
      afterChange();
    }
    return;
  }
  if (isOnline() && to.id !== online.myId) return;

  const list = (props, money) => {
    const items = props.map((i) => `<li>${esc(BOARD[i].name)}${game.squares[i].mortgaged ? ' (hypothéquée)' : ''}</li>`);
    if (money) items.push(`<li>${euro(money)}</li>`);
    return items.length ? `<ul>${items.join('')}</ul>` : '<p>Rien</p>';
  };
  dlg.dataset.offer = '1';
  $('#tradeContent').innerHTML = `
    <h2 class="dialog-title">Proposition pour ${isOnline() ? 'vous' : esc(to.name)}</h2>
    <p class="hint">${esc(from.name)} vous propose un échange.${isOnline() ? '' : ` Passez l’écran à ${esc(to.name)} si besoin.`}</p>
    <div class="trade-cols">
      <div class="offer-box"><strong>Vous recevez</strong>${list(o.give, o.moneyGive)}</div>
      <div class="offer-box"><strong>Vous donnez</strong>${list(o.get, o.moneyGet)}</div>
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn" id="offerNo">Refuser</button>
      <button type="button" class="btn primary" id="offerYes">Accepter</button>
    </div>`;
  const answer = (yes) => { delete dlg.dataset.offer; dlg.close(); perform('respondTrade', yes); };
  $('#offerNo').addEventListener('click', () => answer(false));
  $('#offerYes').addEventListener('click', () => answer(true));
  if (!dlg.open) dlg.showModal();
}

// ---------------------------------------------------------------- Mode en ligne : hôte
function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
}
function uniqueName(name, taken) {
  let n = name || 'Joueur';
  for (let k = 2; taken.includes(n); k++) n = `${name} ${k}`;
  return n;
}

async function createOnlineGame() {
  const name = cleanName($('#onName')?.value) || 'Hôte';
  rememberName(name);
  const code = Net.newCode();
  online.status = 'connecting';
  online.error = '';
  renderOnline();
  try {
    online.net = await Net.host(code, hostHandlers());
  } catch (err) {
    online.status = 'idle';
    online.error = err.message;
    renderOnline();
    return;
  }
  Object.assign(online, {
    mode: 'host', code, myName: name, myId: 0, started: false, status: 'lobby',
    slots: [{ name, isBot: false, connId: 'host' }], conns: new Map(), tokens: {},
  });
  renderOnline();
}

function hostHandlers() {
  return {
    onMessage: onHostMessage,
    onDisconnect: onHostDisconnect,
    onError: (err) => banner(err.message, 'error', 5000),
  };
}

function onHostMessage(connId, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'hello') return onHello(connId, msg);
  if (msg.t === 'action' && online.started) {
    const pid = online.conns.get(connId);
    if (pid === undefined) return;
    applyAction(pid, String(msg.name), Array.isArray(msg.args) ? msg.args : []);
  }
}

function refuse(connId, text) {
  online.net.sendTo(connId, { t: 'refused', msg: text });
  setTimeout(() => online.net?.kick(connId), 500);
}

function onHello(connId, msg) {
  const name = cleanName(msg.name) || 'Joueur';
  if (online.started) {
    // Retour d’un joueur dans une partie en cours
    const byToken = Object.keys(online.tokens).map(Number).find((id) => msg.token && online.tokens[id] === msg.token);
    let pid = byToken;
    if (pid === undefined) {
      pid = game.players.findIndex((p) => p.remote && !p.bankrupt && p.name === name && !connectedIds().includes(p.id));
      if (pid < 0) return refuse(connId, 'La partie a déjà commencé. Demandez à l’hôte d’en créer une nouvelle.');
    }
    for (const [cid, id] of online.conns) {
      if (id === pid) { online.conns.delete(cid); online.net.kick(cid); } // ancienne connexion fantôme
    }
    online.conns.set(connId, pid);
    const p = game.players[pid];
    if (p.isBot && p.remote) p.isBot = false;
    online.net.sendTo(connId, { t: 'welcome', token: online.tokens[pid] });
    game.addLog(`🔌 ${p.name} est de retour.`);
    afterChange();
    return;
  }
  if (online.slots.length >= 6) return refuse(connId, 'La partie est complète (6 joueurs maximum).');
  const token = Net.randomToken();
  online.slots.push({ name: uniqueName(name, online.slots.map((s) => s.name)), isBot: false, connId, token });
  online.net.sendTo(connId, { t: 'welcome', token });
  broadcastLobby();
  renderOnline();
}

function onHostDisconnect(connId) {
  if (!online.started) {
    const k = online.slots.findIndex((s) => s.connId === connId);
    if (k >= 0) online.slots.splice(k, 1);
    broadcastLobby();
    renderOnline();
    return;
  }
  const pid = online.conns.get(connId);
  online.conns.delete(connId);
  if (pid !== undefined && game) {
    game.addLog(`📴 ${game.players[pid].name} s’est déconnecté.`);
    afterChange();
  }
}

function broadcastLobby() {
  const slots = online.slots.map((s) => ({ name: s.name, isBot: s.isBot }));
  online.slots.forEach((s, k) => {
    if (s.connId && s.connId !== 'host') {
      online.net.sendTo(s.connId, { t: 'lobby', code: online.code, slots, you: k, maxTurns: online.maxTurns });
    }
  });
}

function broadcastState(rolled) {
  if (!online.net || !online.started) return;
  const snap = JSON.parse(JSON.stringify(game));
  const ids = connectedIds();
  for (const [connId, pid] of online.conns) {
    online.net.sendTo(connId, { t: 'state', game: snap, you: pid, online: ids, rolled, code: online.code });
  }
}

function hostAddBot() {
  if (online.slots.length >= 6) return;
  const taken = online.slots.map((s) => s.name);
  online.slots.push({ name: BOT_NAMES.find((n) => !taken.includes(n)) || uniqueName('Ordi', taken), isBot: true, connId: null });
  broadcastLobby();
  renderOnline();
}

function hostRemoveSlot(k) {
  const s = online.slots[k];
  if (!s || k === 0) return;
  online.slots.splice(k, 1);
  if (s.connId) refuse(s.connId, 'L’hôte vous a retiré de la partie.');
  broadcastLobby();
  renderOnline();
}

function hostStart() {
  if (online.slots.length < 2) return;
  const players = online.slots.map((s, k) => ({ name: s.name, color: PLAYER_COLORS[k], isBot: s.isBot }));
  game = new Game(players, { maxTurns: online.maxTurns });
  online.conns = new Map();
  online.tokens = {};
  online.slots.forEach((s, k) => {
    if (!s.isBot && s.connId !== 'host') {
      game.players[k].remote = true;
      online.conns.set(s.connId, k);
      online.tokens[k] = s.token;
    }
  });
  online.myId = 0;
  online.started = true;
  online.status = 'playing';
  prevPositions = [];
  $('#setupDialog').close();
  afterChange();
}

/** L’hôte confie à l’ordinateur un joueur parti. Il reprend la main s’il revient. */
function botify(pid) {
  const p = game.players[pid];
  if (online.mode !== 'host' || !p || p.isBot) return;
  p.isBot = true;
  game.addLog(`🤖 L’ordinateur joue pour ${p.name} en son absence.`);
  afterChange();
}

async function resumeHosting(code, attempt = 0) {
  try {
    online.net = await Net.host(code, hostHandlers());
    banner(`Partie ${code} rouverte. Vos amis se reconnectent automatiquement.`, '', 5000);
    render();
  } catch (err) {
    // L’ancien code peut rester réservé quelques secondes après un rechargement
    if (err.code === 'unavailable-id' && attempt < 8) {
      banner('Réouverture de la partie en ligne…');
      setTimeout(() => resumeHosting(code, attempt + 1), 3000);
    } else {
      banner(`Impossible de rouvrir la partie en ligne : ${err.message}`, 'error');
    }
  }
}

// ---------------------------------------------------------------- Mode en ligne : invité
async function joinOnlineGame(code, name, { quiet = false } = {}) {
  code = Net.normalizeCode(code);
  name = cleanName(name);
  if (code.length !== 5) { online.error = 'Le code fait 5 caractères.'; renderOnline(); return; }
  if (!name) { online.error = 'Indiquez votre nom.'; renderOnline(); return; }
  rememberName(name);
  const reconnecting = online.mode === 'guest' && online.started;
  Object.assign(online, { mode: 'guest', code, myName: name, error: '' });
  if (!reconnecting) Object.assign(online, { status: 'connecting', started: false, slots: [] });
  if (!quiet) renderOnline();
  try {
    online.net = await Net.join(code, { onMessage: onGuestMessage, onClose: onGuestClose });
  } catch (err) {
    online.net = null;
    if (reconnecting) throw err; // reconnexion : on réessaiera
    Object.assign(online, { mode: 'local', status: 'idle', error: err.message, code: null });
    store(GUEST_KEY, null);
    renderOnline();
    if (!$('#setupDialog').open) openSetup('online');
    return;
  }
  const saved = read(GUEST_KEY);
  online.net.send({ t: 'hello', name, token: saved?.code === code ? saved.token : undefined });
  store(GUEST_KEY, { code, name, token: saved?.code === code ? saved.token : undefined });
  if (online.status === 'connecting') online.status = 'lobby';
  renderOnline();
}

function onGuestMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'welcome':
      store(GUEST_KEY, { code: online.code, name: online.myName, token: msg.token });
      break;
    case 'lobby':
      online.slots = msg.slots;
      online.myIndex = msg.you;
      online.maxTurns = msg.maxTurns;
      online.status = 'lobby';
      renderOnline();
      break;
    case 'state': {
      const first = !online.started;
      game = Game.fromJSON(msg.game);
      online.myId = msg.you;
      online.connectedIds = msg.online || [];
      online.started = true;
      online.status = 'playing';
      if (first) prevPositions = [];
      if ($('#setupDialog').open && !$('#setupDialog').dataset.manual) $('#setupDialog').close();
      render({ rolled: !!msg.rolled });
      break;
    }
    case 'refused':
      stopGuest('ended');
      if (online.started) {
        banner(msg.msg, 'error');
      } else {
        Object.assign(online, { mode: 'local', status: 'idle', code: null, error: msg.msg });
        renderOnline();
        if (!$('#setupDialog').open) openSetup('online');
      }
      break;
    case 'hostLeft':
      stopGuest('ended');
      banner('L’hôte a quitté la partie. Elle est terminée.', 'error');
      render();
      break;
    default:
      break;
  }
}

function stopGuest(status) {
  online.net?.close();
  online.net = null;
  online.status = status;
  clearTimeout(online.retryTimer);
  store(GUEST_KEY, null);
}

function onGuestClose() {
  if (online.mode !== 'guest' || online.status === 'ended') return;
  online.net = null;
  if (!online.started) {
    Object.assign(online, { mode: 'local', status: 'idle', error: 'La connexion avec l’hôte a été perdue.' });
    renderOnline();
    return;
  }
  online.status = 'lost';
  render();
  retryGuest(0);
}

function retryGuest(attempt) {
  if (online.status !== 'lost') return;
  if (attempt >= 20) {
    banner('Connexion perdue avec l’hôte. Rechargez la page pour réessayer.', 'error');
    return;
  }
  banner('Connexion perdue avec l’hôte. Nouvelle tentative…', 'error');
  online.retryTimer = setTimeout(async () => {
    try {
      await joinOnlineGame(online.code, online.myName, { quiet: true });
      banner('Reconnecté.', '', 2500);
    } catch {
      retryGuest(attempt + 1);
    }
  }, 3000);
}

// ---------------------------------------------------------------- Mode en ligne : commun
function leaveOnline() {
  clearTimeout(online.retryTimer);
  if (online.mode === 'host' && online.net) {
    for (const s of online.slots) if (s.connId && s.connId !== 'host') online.net.sendTo(s.connId, { t: 'hostLeft' });
    for (const cid of online.conns.keys()) online.net.sendTo(cid, { t: 'hostLeft' });
    const net = online.net;
    setTimeout(() => net.close(), 300);
  } else {
    online.net?.close();
  }
  if (online.mode === 'guest' || online.mode === 'host') store(GUEST_KEY, null);
  const wasStarted = online.started;
  Object.assign(online, {
    mode: 'local', code: null, myId: null, net: null, slots: [], started: false,
    conns: new Map(), tokens: {}, connectedIds: [], status: 'idle', error: '',
  });
  hideBanner();
  store(ONLINE_SAVE_KEY, null);
  if (wasStarted) game = null;
  renderNetInfo();
}

function inviteLink(code) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('partie', code);
  if (new URLSearchParams(location.search).get('transport') === 'local') url.searchParams.set('transport', 'local');
  return url.toString();
}

async function shareLink() {
  const link = inviteLink(online.code);
  const btn = $('#onCopy');
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: 'CHADPOLY', text: `Rejoins ma partie de CHADPOLY (code ${online.code})`, url: link });
      return;
    }
    await navigator.clipboard.writeText(link);
    if (btn) btn.textContent = 'Lien copié';
  } catch {
    window.prompt('Copiez ce lien et envoyez-le à vos amis :', link);
  }
}

function rememberName(name) { store(NAME_KEY, name); }

function turnsOptions(selected) {
  return [[0, 'Jusqu’à la faillite de tous les adversaires'], [30, '30 tours, le plus riche gagne'], [50, '50 tours, le plus riche gagne'], [80, '80 tours, le plus riche gagne']]
    .map(([v, l]) => `<option value="${v}"${+selected === v ? ' selected' : ''}>${l}</option>`).join('');
}

function lobbyList(slots, me) {
  return `<ul class="lobby-list">${slots.map((s, k) => `
    <li><span class="dot" style="--c:${PLAYER_COLORS[k]}"></span>
      <span class="who">${esc(s.name)}${k === me ? ' <span class="tag">(vous)</span>' : ''}</span>
      <span class="tag">${k === 0 ? 'hôte' : s.isBot ? 'ordinateur' : 'connecté'}</span>
      ${online.mode === 'host' && k > 0 ? `<button type="button" class="icon-btn" data-kick="${k}" aria-label="Retirer ${esc(s.name)}">×</button>` : ''}
    </li>`).join('')}</ul>`;
}

function renderOnline() {
  const panel = $('#onlinePanel');
  const err = online.error ? `<p class="trade-error" role="alert">${esc(online.error)}</p>` : '';
  let html = '';

  if (online.started && isOnline()) {
    html = `<p>Vous êtes dans la partie en ligne <strong>${esc(online.code)}</strong>.</p>
      <p class="hint">${online.mode === 'host' ? 'Si vous quittez, la partie s’arrête pour tout le monde.' : 'Vous pourrez revenir avec le même lien tant que l’hôte garde la partie ouverte.'}</p>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" id="onBack">Retour à la partie</button>
        <button type="button" class="btn danger" id="onLeave">Quitter la partie en ligne</button>
      </div>`;
  } else if (online.status === 'connecting') {
    html = `<p class="connecting">${online.mode === 'guest' ? `Connexion à la partie ${esc(online.code)}…` : 'Création de la partie…'}</p>
      <div class="dialog-actions"><button type="button" class="btn ghost" id="onLeave">Annuler</button></div>`;
  } else if (online.mode === 'host') {
    const n = online.slots.length;
    html = `<div class="code-box">
        <span class="hint">Code de la partie</span>
        <strong class="code">${esc(online.code)}</strong>
        <div class="row"><button type="button" class="btn" id="onCopy">${navigator.share && matchMedia('(pointer: coarse)').matches ? 'Partager le lien' : 'Copier le lien'}</button></div>
        <p class="hint small">Envoyez le lien à vos amis, ou donnez-leur le code à saisir dans l’onglet « En ligne ».</p>
      </div>
      ${lobbyList(online.slots, 0)}
      <p class="hint">${n < 2 ? 'En attente d’au moins un autre joueur…' : `${n} joueurs sur 6.`}</p>
      <div class="row"><button type="button" class="btn ghost" id="onAddBot"${n >= 6 ? ' disabled' : ''}>Ajouter un ordinateur</button></div>
      <label class="field"><span>Durée</span><select id="onTurns">${turnsOptions(online.maxTurns)}</select></label>
      ${err}
      <div class="dialog-actions">
        <button type="button" class="btn ghost" id="onLeave">Annuler la partie</button>
        <button type="button" class="btn primary" id="onStart"${n < 2 ? ' disabled' : ''}>Lancer la partie</button>
      </div>`;
  } else if (online.mode === 'guest') {
    const hostName = online.slots[0]?.name;
    html = `<div class="code-box"><span class="hint">Partie</span><strong class="code">${esc(online.code)}</strong></div>
      ${online.slots.length ? lobbyList(online.slots, online.myIndex) : ''}
      <p class="hint">${hostName ? `En attente que ${esc(hostName)} lance la partie…` : 'Connecté. En attente de l’hôte…'}</p>
      ${err}
      <div class="dialog-actions"><button type="button" class="btn ghost" id="onLeave">Quitter</button></div>`;
  } else {
    const params = new URLSearchParams(location.search);
    const linkCode = Net.normalizeCode(params.get('partie'));
    const savedName = read(NAME_KEY) || '';
    html = `<p class="hint">Chacun joue sur son propre appareil. L’hôte crée la partie et envoie le lien à ses amis.</p>
      <label class="field"><span>Votre nom</span><input type="text" id="onName" maxlength="16" autocomplete="nickname" value="${esc(savedName)}" placeholder="Votre nom"></label>
      <div class="online-choice">
        <section class="choice-box">
          <h3>Rejoindre une partie</h3>
          <label class="field"><span>Code reçu</span><input type="text" id="onCode" maxlength="5" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABCDE" value="${esc(linkCode)}"></label>
          <button type="button" class="btn${linkCode ? ' primary' : ''}" id="onJoin">Rejoindre</button>
        </section>
        <section class="choice-box">
          <h3>Créer une partie</h3>
          <p class="hint">Vous recevez un code et un lien à partager.</p>
          <button type="button" class="btn${linkCode ? '' : ' primary'}" id="onCreate">Créer une partie</button>
        </section>
      </div>
      ${err}`;
  }
  panel.innerHTML = html;

  const on = (id, fn) => { const el = panel.querySelector(`#${id}`); if (el) el.addEventListener('click', fn); };
  on('onCreate', () => { if ($('#onName').value.trim() || confirm('Continuer sans nom ? Vous serez « Hôte ».')) createOnlineGame(); });
  on('onJoin', () => joinOnlineGame($('#onCode').value, $('#onName').value));
  on('onLeave', () => {
    if (online.started && !confirm(online.mode === 'host' ? 'Arrêter la partie pour tout le monde ?' : 'Quitter la partie en ligne ?')) return;
    leaveOnline();
    renderOnline();
    syncTabs();
  });
  on('onBack', () => $('#setupDialog').close());
  on('onCopy', shareLink);
  on('onAddBot', hostAddBot);
  on('onStart', hostStart);
  panel.querySelector('#onTurns')?.addEventListener('change', (e) => { online.maxTurns = +e.target.value; broadcastLobby(); });
  panel.querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', () => hostRemoveSlot(+b.dataset.kick)));
  const codeInput = panel.querySelector('#onCode');
  codeInput?.addEventListener('input', () => { codeInput.value = Net.normalizeCode(codeInput.value); });
  codeInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinOnlineGame(codeInput.value, $('#onName').value); });
  syncTabs();
}

// ---------------------------------------------------------------- Bandeau d’état réseau
let bannerTimer = null;
function banner(text, kind = '', ms = 0) {
  const el = $('#netBanner');
  el.textContent = text;
  el.className = `net-banner${kind ? ` ${kind}` : ''}`;
  el.hidden = false;
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(hideBanner, ms);
}
function hideBanner() { $('#netBanner').hidden = true; }

// ---------------------------------------------------------------- Configuration
let setupRows = [];
let setupTab = 'local';

function defaultRows() {
  return [
    { name: 'Joueur 1', isBot: false },
    { name: 'Margaux', isBot: true },
    { name: 'Hugo', isBot: true },
  ];
}

function renderSetup() {
  $('#setupPlayers').innerHTML = setupRows.map((r, k) => `
    <div class="setup-player">
      <span class="dot" style="--c:${PLAYER_COLORS[k]}"></span>
      <input type="text" value="${esc(r.name)}" data-k="${k}" maxlength="16" aria-label="Nom du joueur ${k + 1}" required>
      <select data-k="${k}" aria-label="Type du joueur ${k + 1}">
        <option value="h"${r.isBot ? '' : ' selected'}>Humain</option>
        <option value="b"${r.isBot ? ' selected' : ''}>Ordinateur</option>
      </select>
      <button type="button" class="icon-btn" data-remove="${k}" aria-label="Retirer ce joueur"${setupRows.length <= 2 ? ' disabled' : ''}>×</button>
    </div>`).join('');
  $('#addPlayer').disabled = setupRows.length >= 6;
  document.querySelectorAll('.setup-player input').forEach((inp) => inp.addEventListener('input', () => { setupRows[+inp.dataset.k].name = inp.value; }));
  document.querySelectorAll('.setup-player select').forEach((s) => s.addEventListener('change', () => { setupRows[+s.dataset.k].isBot = s.value === 'b'; }));
  document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    setupRows.splice(+b.dataset.remove, 1);
    renderSetup();
  }));
}

function syncTabs() {
  // Pendant la connexion ou dans un salon, on reste sur l’onglet « En ligne »
  const inLobby = isOnline() && online.status !== 'idle' && !online.started;
  if (inLobby) setupTab = 'online';
  $('#tabLocal').setAttribute('aria-selected', String(setupTab === 'local'));
  $('#tabOnline').setAttribute('aria-selected', String(setupTab === 'online'));
  $('#tabLocal').disabled = inLobby;
  $('#setupForm').hidden = setupTab !== 'local';
  $('#onlinePanel').hidden = setupTab !== 'online';
}

function openSetup(tab) {
  if (!setupRows.length) setupRows = defaultRows();
  if (tab) setupTab = tab;
  renderSetup();
  renderOnline();
  const resumable = game && game.phase !== 'gameover';
  $('#resumeBtn').hidden = !resumable;
  $('#botSpeed').value = String(botDelay);
  const dlg = $('#setupDialog');
  dlg.dataset.manual = resumable ? '1' : '';
  if (!dlg.open) dlg.showModal();
}

function startLocalGame() {
  const players = setupRows.map((r, k) => ({
    name: cleanName(r.name) || (r.isBot ? BOT_NAMES[k] : `Joueur ${k + 1}`),
    color: PLAYER_COLORS[k],
    isBot: r.isBot,
  }));
  botDelay = +$('#botSpeed').value;
  game = new Game(players, { maxTurns: +$('#maxTurns').value });
  prevPositions = [];
  afterChange();
}

// ---------------------------------------------------------------- Sauvegarde
function save() {
  if (!game || online.mode === 'guest') return;
  const data = { game, botDelay, setupRows };
  if (online.mode === 'host') {
    data.online = { mode: 'host', code: online.code, tokens: online.tokens, myName: online.myName };
    store(ONLINE_SAVE_KEY, data);
  } else {
    store(SAVE_KEY, data);
  }
}

function load() {
  const data = read(ONLINE_SAVE_KEY) || read(SAVE_KEY);
  if (!data?.game) return false;
  try {
    game = Game.fromJSON(data.game);
  } catch {
    return false;
  }
  botDelay = data.botDelay || botDelay;
  setupRows = data.setupRows || [];
  if (data.online?.mode === 'host' && game.phase !== 'gameover') {
    Object.assign(online, {
      mode: 'host', code: data.online.code, myName: data.online.myName, myId: 0,
      started: true, status: 'playing', tokens: data.online.tokens || {}, conns: new Map(),
    });
  }
  return true;
}

// ---------------------------------------------------------------- Démarrage
function init() {
  buildBoard();
  $('#addPlayer').addEventListener('click', () => {
    setupRows.push({ name: BOT_NAMES.find((n) => !setupRows.some((r) => r.name === n)) || 'Joueur', isBot: true });
    renderSetup();
  });
  $('#setupForm').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'start') return;
    if (isOnline()) {
      if (!confirm('Quitter la partie en ligne et commencer une partie sur cet écran ?')) { e.preventDefault(); return; }
      leaveOnline();
    }
    startLocalGame();
  });
  $('#resumeBtn').addEventListener('click', () => { $('#setupDialog').close(); });
  $('#tabLocal').addEventListener('click', () => { setupTab = 'local'; syncTabs(); });
  $('#tabOnline').addEventListener('click', () => { setupTab = 'online'; renderOnline(); });
  $('#setupDialog').addEventListener('cancel', (e) => {
    // Pas de fermeture par Échap s’il n’y a pas de partie, ou pendant un salon
    if (!game || (isOnline() && !online.started)) e.preventDefault();
  });
  $('#newGameBtn').addEventListener('click', () => openSetup());
  $('#rulesBtn').addEventListener('click', () => $('#rulesDialog').showModal());
  $('#propDialog').addEventListener('close', () => { openPropIdx = null; });
  $('#botSpeed').addEventListener('change', (e) => { botDelay = +e.target.value; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || document.querySelector('dialog[open]') || !canAct()) return;
    if (e.target.closest('button, input, select')) return;
    e.preventDefault();
    if (game.canRoll()) perform('roll');
    else if (game.canEndTurn()) perform('endTurn');
  });

  const linkCode = Net.normalizeCode(new URLSearchParams(location.search).get('partie'));
  const guest = read(GUEST_KEY);
  const hadGame = load();

  // Plateau visible en arrière-plan
  if (hadGame) {
    render();
  } else {
    game = new Game([{ name: 'A', color: PLAYER_COLORS[0] }, { name: 'B', color: PLAYER_COLORS[1] }]);
    game.players.forEach((p) => { p.bankrupt = true; });
    for (let i = 0; i < 40; i++) renderSquare(i);
    renderDice(false);
    game = null;
  }

  if (online.mode === 'host') {
    // L’hôte a rechargé la page : on rouvre la même partie
    if (linkCode && linkCode !== online.code) {
      banner('Vous hébergez déjà une partie. Quittez-la pour en rejoindre une autre.', 'error', 6000);
    }
    resumeHosting(online.code);
    scheduleBot();
    return;
  }
  if (guest?.code && (!linkCode || linkCode === guest.code)) {
    // Un invité a rechargé la page : on se reconnecte sans rien demander
    game = null;
    setupTab = 'online';
    joinOnlineGame(guest.code, guest.name, { quiet: false });
    openSetup('online');
    return;
  }
  if (linkCode) {
    game = null;
    openSetup('online');
    setTimeout(() => $('#onName')?.focus(), 50);
    return;
  }
  if (hadGame) {
    scheduleBot();
  } else {
    openSetup('local');
  }
}

init();
