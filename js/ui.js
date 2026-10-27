// Interface : rendu du plateau, actions des joueurs humains, boucle des bots.
import { Game } from './game.js';
import { botStep, botAcceptsTrade } from './bot.js';
import { BOARD, GROUPS, PLAYER_COLORS, JAIL_FINE } from './data.js';

const SAVE_KEY = 'chadpoly.save.v1';
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = (n) => `${Math.round(n).toLocaleString('fr-FR')} €`;
const DARK_GROUPS = new Set(['brun', 'rose', 'rouge', 'vert', 'marine']);

let game = null;
let botDelay = 450;
let botTimer = null;
let prevPositions = [];
let openPropIdx = null;

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
  for (let i = 0; i < 40; i++) renderSquare(i);
  prevPositions = game.players.map((p) => p.pos);
  renderDice(rolled);
  renderCenter();
  renderPlayers();
  renderLog();
  if (openPropIdx !== null && $('#propDialog').open) renderPropDialog(openPropIdx);
  renderIncomingOffer();
}

function humanTurn() {
  return game.phase !== 'gameover' && !game.player.isBot;
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
    msg.innerHTML = `<p class="winner-title">🏆 ${esc(w.name)} gagne la partie</p>
      <p>Patrimoine final : ${euro(game.netWorth(w.id))}</p>`;
    addBtn('Nouvelle partie', openSetup, 'primary');
    return;
  }

  info.innerHTML = `Tour ${game.turn} : <span class="chip" style="--c:${p.color}"></span><span class="who">${esc(p.name)}</span>${p.isBot ? ' (ordinateur)' : ''} joue`;

  // Message
  let m = '';
  if (game.pendingOffer) {
    m = `<p>${esc(game.players[game.pendingOffer.to].name)} doit répondre à une proposition d’échange.</p>`;
  } else if (p.money < 0) {
    m = `<p class="warn">Il manque ${euro(-p.money)} à ${esc(p.name)}.</p>
      ${p.isBot ? '' : '<p>Vendez des bâtiments ou hypothéquez depuis les fiches de vos propriétés (cliquez sur une case), ou déclarez faillite.</p>'}`;
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
  if (p.isBot && !game.pendingOffer) m += `<p class="pmeta">${esc(p.name)} réfléchit…</p>`;
  msg.innerHTML = m;

  if (p.isBot) return;

  // Actions du joueur humain
  if (game.phase === 'roll') {
    if (p.inJail && !game.pendingOffer) {
      if (p.jailCards > 0) addBtn('Utiliser la carte prison', () => act(() => game.useJailCard()));
      addBtn(`Payer ${JAIL_FINE} €`, () => act(() => game.payJailFine()), '', p.money < JAIL_FINE);
    }
    addBtn(p.inJail ? 'Tenter un double' : 'Lancer les dés', () => act(() => game.roll(), true), 'primary', !game.canRoll());
  } else if (game.phase === 'decide') {
    const def = BOARD[game.pending.idx];
    addBtn(`Acheter pour ${euro(def.price)}`, () => act(() => game.buy()), 'primary', p.money < def.price);
    addBtn('Ne pas acheter', () => act(() => game.decline()));
  } else if (game.phase === 'action') {
    addBtn('Terminer le tour', () => act(() => game.endTurn()), 'primary', !game.canEndTurn());
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
    if (p.isBot) status.push('ordinateur');
    if (p.inJail) status.push('en prison');
    if (p.jailCards) status.push(`${p.jailCards} carte${p.jailCards > 1 ? 's' : ''} prison`);
    if (p.bankrupt) status.push('en faillite');
    return `<article class="player${p.id === game.current && game.phase !== 'gameover' ? ' current' : ''}${p.bankrupt ? ' bankrupt' : ''}" style="--c:${p.color}">
      <div class="player-top"><span class="pname">${esc(p.name)}</span><span class="pmoney${p.money < 0 ? ' neg' : ''}">${euro(p.money)}</span></div>
      <div class="pmeta">Patrimoine ${euro(game.netWorth(p.id))}${status.length ? `, ${status.join(', ')}` : ''}</div>
      ${chips ? `<div class="props">${chips}</div>` : ''}
    </article>`;
  }).join('');
  document.querySelectorAll('.prop-chip').forEach((b) => b.addEventListener('click', () => openProperty(+b.dataset.idx)));
}

function renderLog() {
  const items = game.log.slice(-120).reverse();
  $('#log').innerHTML = items.map((e) => `<li class="${e.msg.startsWith('—') ? 'turn-sep' : ''}">${esc(e.msg)}</li>`).join('');
}

// ---------------------------------------------------------------- Actions
function act(fn, rolling = false) {
  try {
    fn();
  } catch (err) {
    console.warn(err);
  }
  afterChange(rolling);
}

function afterChange(rolled = false) {
  save();
  render({ rolled });
  scheduleBot();
}

function confirmBankruptcy() {
  const p = game.player;
  const assets = game.liquidationValue(p.id) - p.money;
  const text = assets > -p.money
    ? `Vous pourriez encore réunir environ ${euro(assets)} en vendant et hypothéquant. Déclarer faillite quand même ?`
    : 'Déclarer faillite ? Vous quitterez la partie.';
  if (window.confirm(text)) act(() => game.declareBankruptcy(p.id));
}

function scheduleBot() {
  clearTimeout(botTimer);
  if (!game || game.phase === 'gameover' || game.pendingOffer || !game.player.isBot) return;
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
      ? `<p class="hint" style="margin-top:12px">Propriétaire : <strong>${esc(owner.name)}</strong>${sq.mortgaged ? ', hypothéquée' : ''}. Loyer actuel : ${def.type === 'utility' ? 'selon les dés' : euro(game.rentFor(i))}.</p>`
      : `<p class="hint" style="margin-top:12px">À vendre : ${euro(def.price)}.</p>`;
  }

  $('#propContent').innerHTML = `${body}${ownerLine}<div class="dialog-actions" id="propActions"></div>`;
  const box = $('#propActions');
  const add = (label, fn, kind = '') => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `btn ${kind}`; b.textContent = label;
    b.addEventListener('click', () => act(fn));
    box.appendChild(b);
  };

  // Gestion : uniquement le joueur humain dont c’est le tour
  if (owner && owner.id === game.current && humanTurn()) {
    const g = def.group ? GROUPS[def.group] : null;
    if (game.canBuild(i)) add(sq.houses === 4 ? `Construire un hôtel (${euro(g.houseCost)})` : `Construire une maison (${euro(g.houseCost)})`, () => game.build(i), 'primary');
    if (game.canSellBuilding(i)) add(`Vendre ${sq.houses === 5 ? 'l’hôtel' : 'une maison'} (+${euro(g.houseCost / 2)})`, () => game.sellBuilding(i));
    if (game.canMortgage(i)) add(`Hypothéquer (+${euro(def.price / 2)})`, () => game.mortgage(i));
    if (sq.mortgaged) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.textContent = `Lever l’hypothèque (${euro(game.unmortgageCost(i))})`;
      b.disabled = !game.canUnmortgage(i);
      b.addEventListener('click', () => act(() => game.unmortgage(i)));
      box.appendChild(b);
    }
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
    $('#tradeCancel').addEventListener('click', () => $('#tradeDialog').close());
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
    if (botAcceptsTrade(game, offer, partner.id)) {
      game.executeTrade(offer);
      $('#tradeDialog').close();
      afterChange();
    } else {
      game.addLog(`❌ ${partner.name} refuse l’échange proposé par ${me.name}.`);
      $('#tradeError').textContent = `${partner.name} refuse. Essayez d’ajouter de l’argent ou une autre propriété.`;
      save();
      renderLog();
    }
  } else {
    game.proposeTrade(offer);
    $('#tradeDialog').close();
    afterChange();
  }
}

/** Offre en attente vers un humain : on affiche la question (mode « même écran »). */
function renderIncomingOffer() {
  const o = game.pendingOffer;
  const dlg = $('#tradeDialog');
  if (!o) return;
  const to = game.players[o.to];
  const from = game.players[o.from];
  if (to.isBot) { // sécurité : une offre vers un bot est tranchée immédiatement
    game.respondTrade(botAcceptsTrade(game, o, to.id));
    return afterChange();
  }
  const list = (props, money) => {
    const items = props.map((i) => `<li>${esc(BOARD[i].name)}${game.squares[i].mortgaged ? ' (hypothéquée)' : ''}</li>`);
    if (money) items.push(`<li>${euro(money)}</li>`);
    return items.length ? `<ul>${items.join('')}</ul>` : '<p>Rien</p>';
  };
  $('#tradeContent').innerHTML = `
    <h2 class="dialog-title">Proposition pour ${esc(to.name)}</h2>
    <p class="hint">${esc(from.name)} vous propose un échange. Passez l’écran à ${esc(to.name)} si besoin.</p>
    <div class="trade-cols">
      <div class="offer-box"><strong>Vous recevez</strong>${list(o.give, o.moneyGive)}</div>
      <div class="offer-box"><strong>Vous donnez</strong>${list(o.get, o.moneyGet)}</div>
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn" id="offerNo">Refuser</button>
      <button type="button" class="btn primary" id="offerYes">Accepter</button>
    </div>`;
  const answer = (yes) => { dlg.close(); act(() => game.respondTrade(yes)); };
  $('#offerNo').addEventListener('click', () => answer(false));
  $('#offerYes').addEventListener('click', () => answer(true));
  if (!dlg.open) dlg.showModal();
}

// ---------------------------------------------------------------- Configuration
let setupRows = [];

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

function openSetup() {
  if (!setupRows.length) setupRows = defaultRows();
  renderSetup();
  $('#resumeBtn').hidden = !(game && game.phase !== 'gameover');
  $('#botSpeed').value = String(botDelay);
  $('#setupDialog').showModal();
}

function startGame() {
  const names = ['Margaux', 'Hugo', 'Inès', 'Malik', 'Chloé', 'Théo'];
  const players = setupRows.map((r, k) => ({
    name: r.name.trim() || (r.isBot ? names[k] : `Joueur ${k + 1}`),
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
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ game, botDelay, setupRows }));
  } catch { /* stockage indisponible : on continue sans sauvegarde */ }
}
function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    game = Game.fromJSON(data.game);
    botDelay = data.botDelay || botDelay;
    setupRows = data.setupRows || [];
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Démarrage
function init() {
  buildBoard();
  $('#addPlayer').addEventListener('click', () => {
    const names = ['Margaux', 'Hugo', 'Inès', 'Malik', 'Chloé', 'Théo'];
    setupRows.push({ name: names.find((n) => !setupRows.some((r) => r.name === n)) || 'Joueur', isBot: true });
    renderSetup();
  });
  $('#setupForm').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'start') startGame();
  });
  $('#resumeBtn').addEventListener('click', () => { $('#setupDialog').close(); });
  $('#setupDialog').addEventListener('cancel', (e) => { if (!game) e.preventDefault(); });
  $('#newGameBtn').addEventListener('click', openSetup);
  $('#rulesBtn').addEventListener('click', () => $('#rulesDialog').showModal());
  $('#propDialog').addEventListener('close', () => { openPropIdx = null; });
  $('#botSpeed').addEventListener('change', (e) => { botDelay = +e.target.value; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || document.querySelector('dialog[open]') || !game || !humanTurn()) return;
    if (e.target.closest('button, input, select')) return;
    e.preventDefault();
    if (game.canRoll()) act(() => game.roll(), true);
    else if (game.canEndTurn()) act(() => game.endTurn());
  });

  if (load()) {
    render();
    scheduleBot();
  } else {
    // Plateau vide en arrière-plan pendant la configuration
    game = new Game([{ name: 'A', color: PLAYER_COLORS[0] }, { name: 'B', color: PLAYER_COLORS[1] }]);
    game.players.forEach((p) => { p.bankrupt = true; });
    for (let i = 0; i < 40; i++) renderSquare(i);
    renderDice(false);
    game = null;
    openSetup();
  }
}

init();
