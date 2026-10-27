import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../js/game.js';
import { botStep } from '../js/bot.js';

// Générateur pseudo-aléatoire déterministe (mulberry32)
function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const two = () => new Game([{ name: 'Alice', color: 'red' }, { name: 'Bob', color: 'blue' }], { rng: seeded(1) });

test('déplacement et proposition d’achat', () => {
  const g = two();
  g.roll([1, 2]); // case 3 : Allée des Tilleuls
  assert.equal(g.player.pos, 3);
  assert.equal(g.phase, 'decide');
  g.buy();
  assert.equal(g.squares[3].owner, 0);
  assert.equal(g.players[0].money, 1440);
  assert.equal(g.phase, 'action');
});

test('loyer doublé avec le monopole sans maison', () => {
  const g = two();
  g.squares[1].owner = 0; g.squares[3].owner = 0;
  assert.equal(g.rentFor(1), 4);
  g.squares[3].owner = 1;
  assert.equal(g.rentFor(1), 2);
});

test('loyers des gares et compagnies', () => {
  const g = two();
  g.squares[5].owner = 0; g.squares[15].owner = 0; g.squares[25].owner = 0;
  assert.equal(g.rentFor(5), 100);
  g.squares[12].owner = 1;
  assert.equal(g.rentFor(12, { diceTotal: 7 }), 28);
  g.squares[28].owner = 1;
  assert.equal(g.rentFor(12, { diceTotal: 7 }), 70);
});

test('paiement de loyer entre joueurs', () => {
  const g = two();
  g.squares[6].owner = 1;
  g.roll([2, 4]);
  assert.equal(g.players[0].money, 1494);
  assert.equal(g.players[1].money, 1506);
});

test('construction homogène obligatoire', () => {
  const g = two();
  g.squares[1].owner = 0; g.squares[3].owner = 0;
  g.phase = 'action';
  assert.ok(g.canBuild(1));
  g.build(1);
  assert.equal(g.canBuild(1), false, 'doit construire sur l’autre terrain d’abord');
  assert.ok(g.canBuild(3));
  g.build(3);
  assert.ok(g.canBuild(1));
  assert.equal(g.rentFor(1), 10);
});

test('trois doubles envoient en prison', () => {
  const g = two();
  g.roll([1, 1]); if (g.phase === 'decide') g.decline();
  g.roll([2, 2]); if (g.phase === 'decide') g.decline();
  g.roll([3, 3]);
  assert.equal(g.player.inJail, true);
  assert.equal(g.player.pos, 10);
  assert.equal(g.phase, 'action');
});

test('case « Allez en prison »', () => {
  const g = two();
  g.players[0].pos = 25;
  g.roll([2, 3]);
  assert.equal(g.players[0].inJail, true);
});

test('passage par la case Départ', () => {
  const g = two();
  g.players[0].pos = 38;
  g.roll([1, 3]); // 38 → 2 (caisse commune)
  assert.ok(g.players[0].money >= 1500 + 200 - 150);
});

test('hypothèque et levée', () => {
  const g = two();
  g.squares[39].owner = 0;
  g.mortgage(39);
  assert.equal(g.players[0].money, 1700);
  assert.equal(g.rentFor(39), 0);
  g.unmortgage(39);
  assert.equal(g.players[0].money, 1700 - 220);
});

test('faillite : les biens vont au créancier', () => {
  const g = two();
  g.squares[39].owner = 1; g.squares[37].owner = 1;
  g.squares[37].houses = 5; g.squares[39].houses = 5;
  g.squares[1].owner = 0;
  g.players[0].money = 100;
  g.players[0].pos = 35;
  g.roll([1, 3]); // 39 avec hôtel : 2000 €
  assert.ok(g.players[0].money < 0);
  assert.equal(g.canEndTurn(), false);
  g.declareBankruptcy();
  assert.equal(g.phase, 'gameover');
  assert.equal(g.winner, 1);
  assert.equal(g.squares[1].owner, 1);
});

test('sérialisation aller-retour', () => {
  const g = two();
  g.roll([1, 2]); g.buy();
  const copy = Game.fromJSON(JSON.parse(JSON.stringify(g)));
  assert.equal(copy.squares[3].owner, 0);
  assert.equal(copy.player.name, 'Alice');
  assert.equal(copy.phase, 'action');
});

test('parties complètes entre bots sans erreur', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = new Game(
      ['A', 'B', 'C', 'D'].map((n) => ({ name: n, color: '#000', isBot: true })),
      { rng: seeded(seed) },
    );
    let steps = 0;
    while (g.phase !== 'gameover' && steps < 20000) {
      assert.ok(botStep(g), `le bot doit toujours pouvoir agir (seed ${seed})`);
      steps++;
      assert.ok(g.bankHouses >= 0 && g.bankHotels >= 0);
      // Seul le joueur dont c’est le tour peut être endetté
      for (const o of g.players) if (o.id !== g.current) assert.ok(o.money >= 0, `dette hors tour (seed ${seed})`);
    }
    assert.equal(g.phase, 'gameover', `partie non terminée (seed ${seed})`);
  }
});

test('échange de propriétés et d’argent', () => {
  const g = two();
  g.squares[1].owner = 0; g.squares[3].owner = 1;
  const offer = { from: 0, to: 1, give: [], get: [3], moneyGive: 200, moneyGet: 0 };
  assert.equal(g.validateTrade(offer), null);
  g.proposeTrade(offer);
  assert.equal(g.canRoll(), false, 'on attend la réponse');
  g.respondTrade(true);
  assert.equal(g.squares[3].owner, 0);
  assert.equal(g.players[0].money, 1300);
  assert.equal(g.players[1].money, 1700);
  assert.ok(g.hasMonopoly(0, 'brun'));
});

test('pas d’échange de terrain dans un groupe bâti', () => {
  const g = two();
  g.squares[1].owner = 0; g.squares[3].owner = 0; g.squares[3].houses = 1;
  assert.match(g.validateTrade({ from: 0, to: 1, give: [1], get: [], moneyGive: 0, moneyGet: 0 }), /échangeable/);
});

test('limite de tours : le plus riche gagne', () => {
  const g = new Game([{ name: 'A', color: 'x' }, { name: 'B', color: 'y' }], { rng: seeded(3), maxTurns: 1 });
  g.players[1].money = 5000;
  g.roll([1, 2]); g.decline(); g.endTurn();
  g.roll([1, 2]); g.decline(); g.endTurn();
  assert.equal(g.phase, 'gameover');
  assert.equal(g.winner, 1);
});
