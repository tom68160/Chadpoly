// IA simple : effectue UNE action par appel, pour que l’interface puisse animer.
import { BOARD, GROUPS, JAIL_FINE } from './data.js';

const RESERVE = 150; // trésorerie minimale que le bot essaie de garder

/** @returns {boolean} true si une action a été jouée */
export function botStep(game) {
  if (game.phase === 'gameover' || game.pendingOffer) return false;
  const p = game.player;
  if (!p.isBot) return false;

  // 1. Dette : trouver des fonds ou faire faillite
  if (p.money < 0) {
    if (raiseFunds(game, p.id)) return true;
    game.declareBankruptcy(p.id);
    return true;
  }

  // 2. Décision d’achat
  if (game.phase === 'decide' && game.pending?.type === 'buy') {
    const def = BOARD[game.pending.idx];
    const completesGroup = def.type === 'property' && game.groupIndices(def.group)
      .filter(i => i !== game.pending.idx)
      .every(i => game.squares[i].owner === p.id);
    const margin = completesGroup ? 0 : RESERVE;
    if (p.money - def.price >= margin) game.buy(); else game.decline();
    return true;
  }

  // 3. Début de tour
  if (game.phase === 'roll') {
    if (p.inJail) {
      if (p.jailCards > 0) { game.useJailCard(); return true; }
      // Tôt dans la partie, sortir vite pour acheter ; plus tard, rester au chaud.
      const unowned = game.squares.filter((s, i) => BOARD[i].price && s.owner === null).length;
      if (unowned > 8 && p.money >= JAIL_FINE + RESERVE) { game.payJailFine(); return true; }
    }
    game.roll();
    return true;
  }

  // 4. Fin de tour : échanger, lever des hypothèques, construire, puis terminer
  if (game.phase === 'action') {
    if (game.tradeAttempts < 1) {
      game.tradeAttempts++;
      const offer = botFindTrade(game);
      // Entre bots : exécution directe. Vers un humain : l’offre attend sa réponse.
      if (offer && game.players[offer.to].isBot) { game.executeTrade(offer); return true; }
      if (offer) { game.proposeTrade(offer); return true; }
    }
    const mortgaged = game.ownedBy(p.id).filter(i => game.squares[i].mortgaged);
    for (const i of mortgaged) {
      if (p.money - game.unmortgageCost(i) > RESERVE * 2 && game.canUnmortgage(i)) {
        game.unmortgage(i); return true;
      }
    }
    const buildable = game.ownedBy(p.id)
      .filter(i => game.canBuild(i))
      .sort((a, b) => BOARD[b].price - BOARD[a].price);
    for (const i of buildable) {
      if (p.money - GROUPS[BOARD[i].group].houseCost >= RESERVE * 1.5) { game.build(i); return true; }
    }
    game.endTurn();
    return true;
  }
  return false;
}

/** Vend un bâtiment ou hypothèque une propriété. Retourne false s’il n’y a plus rien. */
export function raiseFunds(game, pid) {
  const owned = game.ownedBy(pid);
  // Vendre d’abord les bâtiments des groupes les moins chers
  const sellable = owned.filter(i => game.canSellBuilding(i, pid))
    .sort((a, b) => BOARD[a].price - BOARD[b].price);
  if (sellable.length) { game.sellBuilding(sellable[0], pid); return true; }
  // Puis hypothéquer : compagnies, gares, puis terrains hors monopole
  const score = (i) => {
    const d = BOARD[i];
    if (d.type === 'utility') return 0;
    if (d.type === 'station') return 1;
    return game.hasMonopoly(pid, d.group) ? 3 : 2;
  };
  const mortgageable = owned.filter(i => game.canMortgage(i, pid))
    .sort((a, b) => score(a) - score(b) || BOARD[a].price - BOARD[b].price);
  if (mortgageable.length) { game.mortgage(mortgageable[0], pid); return true; }
  return false;
}

// ---------- Échanges ----------
const MONOPOLY_BONUS = 1.0;   // un monopole vaut ~ deux fois ses terrains
const RIVAL_PENALTY = 0.8;    // offrir un monopole à un rival coûte cher

function groupPrice(group) {
  return BOARD.reduce((s, d) => s + (d.group === group ? d.price : 0), 0);
}

/** Valeur stratégique d’une répartition des propriétés, du point de vue de pid. */
function positionValue(game, pid, owners) {
  let v = 0;
  owners.forEach((o, i) => {
    if (o === pid) v += game.squares[i].mortgaged ? BOARD[i].price / 2 : BOARD[i].price;
  });
  for (const group of Object.keys(GROUPS)) {
    const idx = game.groupIndices(group);
    const first = owners[idx[0]];
    if (first === null || !idx.every(i => owners[i] === first)) continue;
    if (first === pid) v += groupPrice(group) * MONOPOLY_BONUS;
    else v -= groupPrice(group) * RIVAL_PENALTY;
  }
  // Gares : bonus progressif
  const stations = owners.filter((o, i) => o === pid && BOARD[i].type === 'station').length;
  v += [0, 0, 50, 150, 300][stations];
  return v;
}

/** Gain net (en €) qu’un échange apporterait à pid. */
export function tradeGain(game, offer, pid) {
  const before = game.squares.map(s => s.owner);
  const after = [...before];
  for (const i of offer.give) after[i] = offer.to;
  for (const i of offer.get) after[i] = offer.from;
  const money = pid === offer.from
    ? (offer.moneyGet || 0) - (offer.moneyGive || 0)
    : (offer.moneyGive || 0) - (offer.moneyGet || 0);
  return positionValue(game, pid, after) - positionValue(game, pid, before) + money;
}

/** Le bot `pid` accepte-t-il cette offre ? */
export function botAcceptsTrade(game, offer, pid = offer.to) {
  if (game.validateTrade(offer)) return false;
  const p = game.players[pid];
  const money = pid === offer.from
    ? (offer.moneyGet || 0) - (offer.moneyGive || 0)
    : (offer.moneyGive || 0) - (offer.moneyGet || 0);
  if (p.money + money < 50) return false;
  return tradeGain(game, offer, pid) > 20;
}

/** Le bot courant cherche un échange qui lui donne un monopole. Retourne l’offre ou null. */
export function botFindTrade(game) {
  const me = game.player;
  for (const group of Object.keys(GROUPS)) {
    const idx = game.groupIndices(group);
    const mine = idx.filter(i => game.squares[i].owner === me.id);
    const missing = idx.filter(i => game.squares[i].owner !== me.id);
    if (!mine.length || missing.length !== 1) continue;
    const target = missing[0];
    const owner = game.squares[target].owner;
    if (owner === null || game.players[owner].bankrupt) continue;
    if (!game.isTradable(target, owner) || !mine.every(i => game.isTradable(i, me.id))) continue;

    // 1. Essayer un troc : une de mes propriétés qui intéresse l’autre
    const mineToGive = game.ownedBy(me.id)
      .filter(i => BOARD[i].group !== group && game.isTradable(i, me.id));
    for (const g of mineToGive) {
      for (const cash of [0, 50, 100, 200]) {
        const offer = { from: me.id, to: owner, give: [g], get: [target], moneyGive: cash, moneyGet: 0 };
        if (cash > me.money - 100) break;
        if (tradeGain(game, offer, me.id) > 0 && botAcceptsTrade(game, offer, owner)) return offer;
      }
    }
    // 2. Sinon, une offre en argent
    for (const mult of [1.5, 2, 2.5, 3]) {
      const cash = Math.round((BOARD[target].price * mult + groupPrice(group) * RIVAL_PENALTY) / 10) * 10;
      if (cash > me.money - 100) break;
      const offer = { from: me.id, to: owner, give: [], get: [target], moneyGive: cash, moneyGet: 0 };
      if (tradeGain(game, offer, me.id) > 0 && botAcceptsTrade(game, offer, owner)) return offer;
    }
  }
  return null;
}
