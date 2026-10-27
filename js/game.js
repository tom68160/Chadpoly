// Moteur de jeu — aucune dépendance au DOM, testable avec Node.
import {
  BOARD, GROUPS, CHANCE_CARDS, CHEST_CARDS,
  JAIL_POS, GO_SALARY, JAIL_FINE, START_MONEY,
} from './data.js';

const BANK = -1;
const MAX_HOUSES = 32;
const MAX_HOTELS = 12;

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Game {
  /**
   * @param {{name:string,color:string,isBot?:boolean}[]} players
   * @param {{rng?:()=>number}} opts
   */
  constructor(players, opts = {}) {
    this.rng = opts.rng || Math.random;
    if (!players) return; // utilisé par Game.fromJSON
    if (players.length < 2 || players.length > 6) throw new Error('2 à 6 joueurs');
    this.squares = BOARD.map(() => ({ owner: null, houses: 0, mortgaged: false }));
    this.players = players.map((p, i) => ({
      id: i, name: p.name, color: p.color, isBot: !!p.isBot,
      money: START_MONEY, pos: 0,
      inJail: false, jailTurns: 0, jailCards: 0,
      bankrupt: false, debtTo: null,
    }));
    this.current = 0;
    this.phase = 'roll';         // roll | decide | action | gameover
    this.pending = null;         // { type:'buy', idx }
    this.dice = [0, 0];
    this.doublesCount = 0;
    this.extraRoll = false;
    this.turn = 1;
    this.maxTurns = opts.maxTurns || 0; // 0 = partie illimitée
    this.winner = null;
    this.pendingOffer = null;    // échange proposé, en attente de réponse
    this.tradeAttempts = 0;      // propositions faites par le joueur courant ce tour-ci
    this.bankHouses = MAX_HOUSES;
    this.bankHotels = MAX_HOTELS;
    this.decks = {
      chance: shuffle(CHANCE_CARDS.map((_, i) => i), this.rng),
      chest: shuffle(CHEST_CARDS.map((_, i) => i), this.rng),
    };
    this.heldCards = []; // { deck, index } cartes « libéré de prison » détenues
    this.lastCard = null;
    this.log = [];
    this.addLog(`La partie commence ! ${this.player.name} joue en premier.`);
  }

  // ---------- Sérialisation ----------
  toJSON() {
    const { rng, ...rest } = this;
    return rest;
  }
  static fromJSON(data, opts = {}) {
    const g = new Game(null, opts);
    Object.assign(g, structuredClone(data));
    return g;
  }

  // ---------- Accès ----------
  get player() { return this.players[this.current]; }
  get activePlayers() { return this.players.filter(p => !p.bankrupt); }
  square(i) { return { ...BOARD[i], ...this.squares[i], idx: i }; }

  addLog(msg) {
    this.log.push({ turn: this.turn, msg });
    if (this.log.length > 300) this.log.shift();
  }

  ownedBy(pid) {
    return this.squares.map((s, i) => i).filter(i => this.squares[i].owner === pid);
  }
  groupIndices(group) {
    return BOARD.map((s, i) => i).filter(i => BOARD[i].group === group);
  }
  hasMonopoly(pid, group) {
    return this.groupIndices(group).every(i => this.squares[i].owner === pid);
  }
  countOwned(pid, type) {
    return BOARD.filter((s, i) => s.type === type && this.squares[i].owner === pid).length;
  }

  rentFor(idx, { diceTotal = this.dice[0] + this.dice[1], cardMultiplier = null } = {}) {
    const def = BOARD[idx];
    const sq = this.squares[idx];
    if (sq.owner === null || sq.mortgaged) return 0;
    if (def.type === 'property') {
      if (sq.houses > 0) return def.rents[sq.houses];
      const base = def.rents[0];
      return this.hasMonopoly(sq.owner, def.group) ? base * 2 : base;
    }
    if (def.type === 'station') {
      const n = this.countOwned(sq.owner, 'station');
      const rent = 25 * 2 ** (n - 1);
      return cardMultiplier ? rent * cardMultiplier : rent;
    }
    if (def.type === 'utility') {
      if (cardMultiplier) return diceTotal * cardMultiplier;
      const n = this.countOwned(sq.owner, 'utility');
      return diceTotal * (n === 2 ? 10 : 4);
    }
    return 0;
  }

  /** Valeur totale récupérable (liquidation) d’un joueur. */
  liquidationValue(pid) {
    const p = this.players[pid];
    let total = p.money;
    for (const i of this.ownedBy(pid)) {
      const def = BOARD[i], sq = this.squares[i];
      if (def.type === 'property' && sq.houses > 0) {
        total += (sq.houses * GROUPS[def.group].houseCost) / 2;
      }
      if (!sq.mortgaged) total += def.price / 2;
    }
    return total;
  }

  netWorth(pid) {
    const p = this.players[pid];
    let total = p.money;
    for (const i of this.ownedBy(pid)) {
      const def = BOARD[i], sq = this.squares[i];
      total += sq.mortgaged ? def.price / 2 : def.price;
      if (def.type === 'property') total += sq.houses * GROUPS[def.group].houseCost;
    }
    return total;
  }

  // ---------- Argent ----------
  /** Le joueur reçoit de l’argent ; s’il était endetté, son créancier est payé en priorité. */
  _credit(p, amount) {
    if (amount <= 0) return;
    if (p.money < 0 && p.debtTo !== null && p.debtTo !== BANK) {
      const toCreditor = Math.min(amount, -p.money);
      this.players[p.debtTo].money += toCreditor;
    }
    p.money += amount;
    if (p.money >= 0) p.debtTo = null;
  }

  /** Paiement de `p` vers `to` (id joueur ou BANK). Peut rendre le solde négatif (dette). */
  _pay(p, amount, to = BANK) {
    if (amount <= 0) return;
    const available = Math.max(0, Math.min(p.money, amount));
    if (to !== BANK) this.players[to].money += available;
    p.money -= amount;
    if (p.money < 0) {
      p.debtTo = to;
      this.addLog(`⚠️ ${p.name} doit encore ${-p.money} € : vendez ou hypothéquez, sinon faillite.`);
    }
  }

  // ---------- Tour de jeu ----------
  canRoll() {
    return this.phase === 'roll' && this.player.money >= 0 && !this.pendingOffer;
  }

  roll(forced = null) {
    if (!this.canRoll()) throw new Error('Impossible de lancer les dés maintenant');
    const p = this.player;
    const d1 = forced ? forced[0] : 1 + Math.floor(this.rng() * 6);
    const d2 = forced ? forced[1] : 1 + Math.floor(this.rng() * 6);
    this.dice = [d1, d2];
    const doubles = d1 === d2;
    const total = d1 + d2;
    this.lastCard = null;
    this.addLog(`${p.name} lance ${d1} + ${d2} = ${total}${doubles ? ' (double !)' : ''}`);

    if (p.inJail) {
      if (doubles) {
        p.inJail = false; p.jailTurns = 0;
        this.addLog(`${p.name} sort de prison grâce au double.`);
        this.extraRoll = false;
        this._move(p, total);
      } else {
        p.jailTurns++;
        if (p.jailTurns >= 3) {
          this.addLog(`${p.name} paie ${JAIL_FINE} € et sort de prison après 3 tours.`);
          this._pay(p, JAIL_FINE);
          p.inJail = false; p.jailTurns = 0;
          this.extraRoll = false;
          this._move(p, total);
        } else {
          this.addLog(`${p.name} reste en prison (${p.jailTurns}/3).`);
          this.extraRoll = false;
        }
      }
      return this._afterAction();
    }

    if (doubles) {
      this.doublesCount++;
      if (this.doublesCount >= 3) {
        this.addLog(`Trois doubles d’affilée : ${p.name} va en prison !`);
        this._goToJail(p);
        return this._afterAction();
      }
      this.extraRoll = true;
    } else {
      this.extraRoll = false;
    }
    this._move(p, total);
    return this._afterAction();
  }

  _afterAction() {
    if (this.phase === 'gameover') return;
    if (this.pending) { this.phase = 'decide'; return; }
    const p = this.player;
    this.phase = (this.extraRoll && !p.inJail && !p.bankrupt) ? 'roll' : 'action';
  }

  _move(p, steps) {
    const from = p.pos;
    p.pos = (p.pos + steps + 40) % 40;
    if (steps > 0 && p.pos < from) {
      this._credit(p, GO_SALARY);
      this.addLog(`${p.name} passe par la case Départ et reçoit ${GO_SALARY} €.`);
    }
    this._land(p);
  }

  _moveTo(p, to, ctx = {}) {
    if (to < p.pos) {
      this._credit(p, GO_SALARY);
      this.addLog(`${p.name} passe par la case Départ et reçoit ${GO_SALARY} €.`);
    }
    p.pos = to;
    this._land(p, ctx);
  }

  _goToJail(p) {
    p.pos = JAIL_POS;
    p.inJail = true;
    p.jailTurns = 0;
    this.extraRoll = false;
    this.doublesCount = 0;
  }

  _land(p, ctx = {}) {
    const idx = p.pos;
    const def = BOARD[idx];
    const sq = this.squares[idx];
    this.addLog(`${p.name} arrive sur « ${def.name} ».`);

    switch (def.type) {
      case 'property':
      case 'station':
      case 'utility': {
        if (sq.owner === null) {
          this.pending = { type: 'buy', idx };
        } else if (sq.owner !== p.id) {
          const owner = this.players[sq.owner];
          if (sq.mortgaged) {
            this.addLog(`Propriété hypothéquée : pas de loyer.`);
          } else {
            let diceTotal = this.dice[0] + this.dice[1];
            if (ctx.cardMultiplier && def.type === 'utility') {
              const r1 = 1 + Math.floor(this.rng() * 6), r2 = 1 + Math.floor(this.rng() * 6);
              diceTotal = r1 + r2;
              this.addLog(`Nouveau lancer pour la compagnie : ${r1} + ${r2}.`);
            }
            const rent = this.rentFor(idx, { diceTotal, cardMultiplier: ctx.cardMultiplier });
            this.addLog(`${p.name} paie ${rent} € de loyer à ${owner.name}.`);
            this._pay(p, rent, owner.id);
          }
        }
        break;
      }
      case 'tax':
        this.addLog(`${p.name} paie ${def.amount} € (${def.name}).`);
        this._pay(p, def.amount);
        break;
      case 'chance':
      case 'chest':
        this._drawCard(p, def.type);
        break;
      case 'gotojail':
        this.addLog(`${p.name} va en prison !`);
        this._goToJail(p);
        break;
      default:
        break;
    }
  }

  _drawCard(p, deckName) {
    const deck = this.decks[deckName];
    const cardIdx = deck.shift();
    const card = (deckName === 'chance' ? CHANCE_CARDS : CHEST_CARDS)[cardIdx];
    this.lastCard = { deck: deckName, text: card.text };
    this.addLog(`🃏 ${deckName === 'chance' ? 'Chance' : 'Caisse commune'} : ${card.text}`);

    if (card.kind === 'jailCard') {
      p.jailCards++;
      this.heldCards.push({ deck: deckName, index: cardIdx, owner: p.id });
      return; // la carte n’est pas remise dans la pioche
    }
    deck.push(cardIdx);

    switch (card.kind) {
      case 'moveTo':
        this._moveTo(p, card.to);
        break;
      case 'nearest': {
        let i = p.pos;
        do { i = (i + 1) % 40; } while (BOARD[i].type !== card.target);
        this._moveTo(p, i, { cardMultiplier: card.target === 'station' ? 2 : 10 });
        break;
      }
      case 'back':
        p.pos = (p.pos - card.steps + 40) % 40;
        this._land(p);
        break;
      case 'jail':
        this._goToJail(p);
        break;
      case 'money':
        if (card.amount > 0) this._credit(p, card.amount);
        else this._pay(p, -card.amount);
        break;
      case 'repairs': {
        let cost = 0;
        for (const i of this.ownedBy(p.id)) {
          const h = this.squares[i].houses;
          cost += h === 5 ? card.hotel : h * card.house;
        }
        this.addLog(`Coût des réparations : ${cost} €.`);
        this._pay(p, cost);
        break;
      }
      case 'payEach':
        for (const o of this.activePlayers) if (o.id !== p.id) this._pay(p, card.amount, o.id);
        break;
      case 'collectEach':
        for (const o of this.activePlayers) {
          // Les autres joueurs ne paient que ce qu’ils ont (pas de dette hors de leur tour)
          if (o.id !== p.id) {
            const gift = Math.max(0, Math.min(card.amount, o.money));
            o.money -= gift;
            this._credit(p, gift);
          }
        }
        break;
    }
  }

  // ---------- Décisions ----------
  buy() {
    if (this.phase !== 'decide' || this.pending?.type !== 'buy') throw new Error('Rien à acheter');
    const p = this.player;
    const { idx } = this.pending;
    const def = BOARD[idx];
    if (p.money < def.price) throw new Error('Fonds insuffisants');
    p.money -= def.price;
    this.squares[idx].owner = p.id;
    this.addLog(`${p.name} achète « ${def.name} » pour ${def.price} €.`);
    this.pending = null;
    this._afterAction();
  }

  decline() {
    if (this.phase !== 'decide') throw new Error('Aucune décision en cours');
    this.addLog(`${this.player.name} n’achète pas « ${BOARD[this.pending.idx].name} ».`);
    this.pending = null;
    this._afterAction();
  }

  payJailFine() {
    const p = this.player;
    if (this.phase !== 'roll' || !p.inJail || p.money < JAIL_FINE) throw new Error('Impossible');
    p.money -= JAIL_FINE;
    p.inJail = false; p.jailTurns = 0;
    this.addLog(`${p.name} paie ${JAIL_FINE} € et sort de prison.`);
  }

  useJailCard() {
    const p = this.player;
    if (this.phase !== 'roll' || !p.inJail || p.jailCards < 1) throw new Error('Impossible');
    const k = this.heldCards.findIndex(c => c.owner === p.id);
    const held = this.heldCards.splice(k, 1)[0];
    this.decks[held.deck].push(held.index);
    p.jailCards--;
    p.inJail = false; p.jailTurns = 0;
    this.addLog(`${p.name} utilise sa carte « Libéré de prison ».`);
  }

  canEndTurn() {
    return this.phase === 'action' && this.player.money >= 0 && !this.pendingOffer;
  }

  endTurn() {
    if (!this.canEndTurn()) throw new Error('Impossible de terminer le tour');
    this._nextPlayer();
  }

  _nextPlayer() {
    if (this.phase === 'gameover') return;
    this.doublesCount = 0;
    this.extraRoll = false;
    this.pending = null;
    let n = this.current;
    do { n = (n + 1) % this.players.length; } while (this.players[n].bankrupt);
    if (n <= this.current) this.turn++;
    if (this.maxTurns && this.turn > this.maxTurns) return this._endByTurnLimit();
    this.current = n;
    this.tradeAttempts = 0;
    this.phase = 'roll';
    this.addLog(`— Au tour de ${this.player.name}.`);
  }

  // ---------- Gestion des propriétés (joueur courant, ou endetté) ----------
  _assertOwner(idx, pid) {
    if (this.squares[idx].owner !== pid) throw new Error('Pas votre propriété');
  }

  canBuild(idx, pid = this.current) {
    const def = BOARD[idx], sq = this.squares[idx];
    if (this.phase === 'gameover' || def.type !== 'property' || sq.owner !== pid) return false;
    if (!this.hasMonopoly(pid, def.group)) return false;
    const group = this.groupIndices(def.group);
    if (group.some(i => this.squares[i].mortgaged)) return false;
    if (sq.houses >= 5) return false;
    const min = Math.min(...group.map(i => this.squares[i].houses));
    if (sq.houses > min) return false; // construction homogène
    if (sq.houses === 4 ? this.bankHotels < 1 : this.bankHouses < 1) return false;
    return this.players[pid].money >= GROUPS[def.group].houseCost;
  }

  build(idx, pid = this.current) {
    if (!this.canBuild(idx, pid)) throw new Error('Construction impossible');
    const def = BOARD[idx], sq = this.squares[idx];
    const p = this.players[pid];
    p.money -= GROUPS[def.group].houseCost;
    if (sq.houses === 4) { this.bankHouses += 4; this.bankHotels--; } else { this.bankHouses--; }
    sq.houses++;
    this.addLog(`${p.name} construit ${sq.houses === 5 ? 'un hôtel' : 'une maison'} sur « ${def.name} ».`);
  }

  canSellBuilding(idx, pid = this.current) {
    const def = BOARD[idx], sq = this.squares[idx];
    if (def.type !== 'property' || sq.owner !== pid || sq.houses === 0) return false;
    const group = this.groupIndices(def.group);
    const max = Math.max(...group.map(i => this.squares[i].houses));
    if (sq.houses < max) return false;
    // Vendre un hôtel exige 4 maisons disponibles en banque
    if (sq.houses === 5 && this.bankHouses < 4) return false;
    return true;
  }

  sellBuilding(idx, pid = this.current) {
    if (!this.canSellBuilding(idx, pid)) throw new Error('Vente impossible');
    const def = BOARD[idx], sq = this.squares[idx];
    if (sq.houses === 5) { this.bankHotels++; this.bankHouses -= 4; } else { this.bankHouses++; }
    sq.houses--;
    const value = GROUPS[def.group].houseCost / 2;
    this._credit(this.players[pid], value);
    this.addLog(`${this.players[pid].name} revend un bâtiment de « ${def.name} » (+${value} €).`);
  }

  canMortgage(idx, pid = this.current) {
    const def = BOARD[idx], sq = this.squares[idx];
    if (!def.price || sq.owner !== pid || sq.mortgaged) return false;
    if (def.type === 'property' && this.groupIndices(def.group).some(i => this.squares[i].houses > 0)) return false;
    return true;
  }

  mortgage(idx, pid = this.current) {
    if (!this.canMortgage(idx, pid)) throw new Error('Hypothèque impossible');
    const def = BOARD[idx];
    this.squares[idx].mortgaged = true;
    this._credit(this.players[pid], def.price / 2);
    this.addLog(`${this.players[pid].name} hypothèque « ${def.name} » (+${def.price / 2} €).`);
  }

  unmortgageCost(idx) {
    return Math.ceil((BOARD[idx].price * 11) / 20); // 50 % + 10 % d’intérêts
  }

  canUnmortgage(idx, pid = this.current) {
    const sq = this.squares[idx];
    return sq.owner === pid && sq.mortgaged && this.players[pid].money >= this.unmortgageCost(idx);
  }

  unmortgage(idx, pid = this.current) {
    if (!this.canUnmortgage(idx, pid)) throw new Error('Levée impossible');
    const cost = this.unmortgageCost(idx);
    this.players[pid].money -= cost;
    this.squares[idx].mortgaged = false;
    this.addLog(`${this.players[pid].name} lève l’hypothèque de « ${BOARD[idx].name} » (-${cost} €).`);
  }

  _endByTurnLimit() {
    const ranking = [...this.activePlayers].sort((a, b) => this.netWorth(b.id) - this.netWorth(a.id));
    this.winner = ranking[0].id;
    this.phase = 'gameover';
    this.pending = null;
    this.addLog(`⏱️ Limite de ${this.maxTurns} tours atteinte.`);
    this.addLog(`🏆 ${ranking[0].name} gagne avec un patrimoine de ${this.netWorth(ranking[0].id)} € !`);
  }

  // ---------- Échanges ----------
  /** Une propriété est échangeable si aucun terrain de son groupe n’est bâti. */
  isTradable(idx, pid) {
    const def = BOARD[idx], sq = this.squares[idx];
    if (!def.price || sq.owner !== pid) return false;
    if (def.type === 'property' && this.groupIndices(def.group).some(i => this.squares[i].houses > 0)) return false;
    return true;
  }

  /**
   * offer = { from, to, give:[idx], get:[idx], moneyGive, moneyGet }
   * « from » cède give + moneyGive, et reçoit get + moneyGet.
   */
  validateTrade(o) {
    if (this.phase === 'gameover') return 'Partie terminée';
    if (o.from === o.to) return 'Choisissez un autre joueur';
    const a = this.players[o.from], b = this.players[o.to];
    if (!a || !b || a.bankrupt || b.bankrupt) return 'Joueur invalide';
    const mg = o.moneyGive || 0, mt = o.moneyGet || 0;
    if (mg < 0 || mt < 0) return 'Montant invalide';
    if (mg > a.money) return `${a.name} n’a pas assez d’argent`;
    if (mt > b.money) return `${b.name} n’a pas assez d’argent`;
    if (!o.give.length && !o.get.length && !mg && !mt) return 'L’échange est vide';
    if (!o.give.every(i => this.isTradable(i, a.id))) return 'Une propriété proposée n’est pas échangeable';
    if (!o.get.every(i => this.isTradable(i, b.id))) return 'Une propriété demandée n’est pas échangeable';
    return null;
  }

  /** Offre en attente de la réponse d’un joueur humain. */
  proposeTrade(o) {
    const err = this.validateTrade(o);
    if (err) throw new Error(err);
    this.pendingOffer = o;
    this.addLog(`📨 ${this.players[o.from].name} propose un échange à ${this.players[o.to].name}.`);
  }

  respondTrade(accept) {
    const o = this.pendingOffer;
    if (!o) throw new Error('Aucune offre en attente');
    this.pendingOffer = null;
    if (accept && !this.validateTrade(o)) this.executeTrade(o);
    else this.addLog(`❌ ${this.players[o.to].name} refuse l’échange.`);
  }

  executeTrade(o) {
    const err = this.validateTrade(o);
    if (err) throw new Error(err);
    const a = this.players[o.from], b = this.players[o.to];
    for (const i of o.give) this.squares[i].owner = b.id;
    for (const i of o.get) this.squares[i].owner = a.id;
    a.money += (o.moneyGet || 0) - (o.moneyGive || 0);
    b.money += (o.moneyGive || 0) - (o.moneyGet || 0);
    const names = (l) => l.map(i => BOARD[i].name).join(', ');
    const partA = [names(o.give), o.moneyGive ? `${o.moneyGive} €` : ''].filter(Boolean).join(' + ') || 'rien';
    const partB = [names(o.get), o.moneyGet ? `${o.moneyGet} €` : ''].filter(Boolean).join(' + ') || 'rien';
    this.addLog(`🤝 Échange : ${a.name} donne ${partA} à ${b.name} contre ${partB}.`);
  }

  // ---------- Faillite ----------
  /** Joueur endetté (normalement le joueur courant). */
  get debtor() {
    return this.players.find(p => !p.bankrupt && p.money < 0) || null;
  }

  declareBankruptcy(pid = this.debtor?.id) {
    const p = this.players[pid];
    if (!p || p.money >= 0) throw new Error('Pas de dette');
    const creditorId = p.debtTo;
    const creditor = creditorId !== null && creditorId !== BANK ? this.players[creditorId] : null;
    this.addLog(`💥 ${p.name} fait faillite${creditor ? ` au profit de ${creditor.name}` : ''} !`);

    for (const i of this.ownedBy(pid)) {
      const def = BOARD[i], sq = this.squares[i];
      if (sq.houses > 0) {
        const value = (sq.houses * GROUPS[def.group].houseCost) / 2;
        if (sq.houses === 5) { this.bankHotels++; } else { this.bankHouses += sq.houses; }
        sq.houses = 0;
        if (creditor) creditor.money += value;
      }
      if (creditor) {
        sq.owner = creditor.id; // les hypothèques sont conservées
      } else {
        sq.owner = null; sq.mortgaged = false;
      }
    }
    for (const c of this.heldCards) {
      if (c.owner !== pid) continue;
      if (creditor) { c.owner = creditor.id; creditor.jailCards++; }
    }
    if (!creditor) {
      this.heldCards = this.heldCards.filter(c => {
        if (c.owner === pid) { this.decks[c.deck].push(c.index); return false; }
        return true;
      });
    }
    p.jailCards = 0;
    p.money = 0;
    p.bankrupt = true;
    p.debtTo = null;
    p.inJail = false;

    const alive = this.activePlayers;
    if (alive.length === 1) {
      this.winner = alive[0].id;
      this.phase = 'gameover';
      this.pending = null;
      this.addLog(`🏆 ${alive[0].name} remporte la partie !`);
      return;
    }
    if (pid === this.current) this._nextPlayer();
  }
}

export { BANK };
